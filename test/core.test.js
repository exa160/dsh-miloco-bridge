import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as infra from '../lib/index.js'
import * as toolsHalf from '../lib/tools-entry.js'
import { createMilocoTools } from '../lib/tools.js'
import { createOverlay, normalizeOverlay } from '../lib/overlay.js'
import { AGENT_MODES, clearSessions, createStateStore, describeMode, noteSession, readSessions } from '../lib/state.js'
import { parseFrontmatter, registerSkills } from '../lib/skills.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
let workdir

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-bridge-test-'))
})

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('configuration', () => {
  it('infra defaults are independent of any machine-specific path', () => {
    const config = infra.normalizeConfig({})
    assert.equal(config.push.path, '/miloco/webhook')
    assert.equal(config.push.target.agentPreset, 'miloco')
    assert.equal(config.readOnly, true)
    assert.ok(config.overlayFile.endsWith('miloco-plugin.json'))
    assert.ok(config.deploy.repo.startsWith('https://github.com/'))
    assert.ok(String(config.deploy.sourceDir).includes('plugin-data'))
    assert.ok(String(config.deploy.sourceDir).endsWith('xiaomi-miloco'))
    assert.ok(!String(config.deploy.sourceDir).includes('default-workspace'))
  })

  it('tool half defaults match the preset', () => {
    const config = toolsHalf.normalizeConfig({})
    assert.equal(config.readOnly, true)
    assert.equal(config.push.path, '/miloco/webhook')
  })

  it('overlay normalisation keeps connection, token and push target', () => {
    const value = normalizeOverlay({
      connection: { baseUrl: ' http://127.0.0.1:1810 ', token: 'x' },
      push: {
        token: 'p',
        target: { sessionId: ' s1 ' },
        model: { provider: 'p1', model: 'm1', reasoningEffort: 'low' },
        mode: 'ignored',
      },
    })
    assert.equal(value.connection.baseUrl, 'http://127.0.0.1:1810')
    assert.equal(value.connection.token, 'x')
    assert.equal(value.push.token, 'p')
    assert.equal(value.push.target.sessionId, 's1')
    assert.equal(value.push.model.provider, 'p1')
    assert.equal('mode' in value.push.target, false)
  })

  it('overlay writes atomically with mode 0600', async () => {
    const file = join(workdir, 'overlay.json')
    const overlay = createOverlay({ file })
    await overlay.write({ connection: { baseUrl: 'http://a', token: 't' } })
    const mode = (await stat(file)).mode & 0o777
    assert.equal(mode, 0o600)
    const value = await overlay.current()
    assert.equal(value.connection.baseUrl, 'http://a')
    assert.equal(value.push.target.sessionId, '')
  })
})

describe('tools', () => {
  it('read-only registers only read tools; full adds writes', () => {
    const client = { endpoint: async () => ({ baseUrl: 'http://x', token: '', home: '/tmp' }), request: async () => ({}) }
    const read = createMilocoTools({ client, readOnly: true })
    const full = createMilocoTools({ client, readOnly: false })
    assert.equal(read.length, 30)
    assert.equal(full.length, 56)
    const readNames = new Set(read.map(tool => tool.name))
    const fullNames = new Set(full.map(tool => tool.name))
    assert.ok(!readNames.has('miloco_device_control'))
    for (const name of [
      'miloco_device_control',
      'miloco_notify_push',
      'miloco_task_create',
      'miloco_task_record_init',
      'miloco_rule_delete',
      'miloco_task_delete',
      'miloco_cron_delete',
      'miloco_scope_set',
      'miloco_person_create',
      'miloco_pet_reference_crops',
      'miloco_register_commit',
      'miloco_push_target_set',
    ]) {
      assert.ok(fullNames.has(name), `missing ${name}`)
    }
  })

  it('a tool call records its durable session id', async () => {
    const state = createStateStore({ file: join(workdir, 'state-tool.json') })
    const client = {
      endpoint: async () => ({ baseUrl: 'http://x', token: '', home: '/tmp' }),
      request: async () => ({}),
    }
    const tools = createMilocoTools({ client, readOnly: true, state })
    const statusTool = tools.find(tool => tool.name === 'miloco_status')
    await statusTool.execute({}, { agent: { session: { header: { id: 'sess-durable' } } } })
    await new Promise(resolve => setTimeout(resolve, 200))
    const sessions = await readSessions(state)
    assert.equal(sessions.last, 'sess-durable')
  })

  it('push target tool preserves connection and push token', async () => {
    const file = join(workdir, 'overlay-tool.json')
    const overlay = createOverlay({ file })
    await overlay.write({
      connection: { baseUrl: 'http://a', token: 'conn' },
      push: { token: 'push', target: { sessionId: '' }, model: { provider: '', model: '', reasoningEffort: '' } },
    })
    const client = { endpoint: async () => ({ baseUrl: 'http://a', token: 'conn', home: '/tmp' }), request: async () => ({}) }
    const tools = createMilocoTools({ client, readOnly: false, overlay })
    const tool = tools.find(item => item.name === 'miloco_push_target_set')
    await tool.execute({ sessionId: 's9', provider: 'p', model: 'm' }, {})
    const value = await overlay.current()
    assert.equal(value.connection.baseUrl, 'http://a')
    assert.equal(value.connection.token, 'conn')
    assert.equal(value.push.token, 'push')
    assert.equal(value.push.target.sessionId, 's9')
    assert.equal(value.push.model.provider, 'p')
  })
})

describe('modes', () => {
  it('offers only read-only and full, and migrates old chat to read-only', () => {
    assert.deepEqual(AGENT_MODES, ['readonly', 'full'])
    assert.equal(describeMode('chat').id, 'readonly')
    assert.equal(describeMode('full').writeTools, true)
    assert.equal(describeMode('readonly').writeTools, false)
    assert.ok(!describeMode('full').description.includes('动真格'))
  })
})

describe('state', () => {
  it('records and clears the last Miloco session', async () => {
    const state = createStateStore({ file: join(workdir, 'state.json') })
    await noteSession(state, 'sess-1')
    await noteSession(state, 'sess-2')
    const value = await readSessions(state)
    assert.equal(value.last, 'sess-2')
    assert.deepEqual(value.sessions, ['sess-2', 'sess-1'])
    await clearSessions(state, ['sess-2'])
    const afterClear = await readSessions(state)
    assert.equal(afterClear.last, '')
    assert.deepEqual(afterClear.sessions, ['sess-1'])
  })

  it('accepts the legacy string-array state shape', async () => {
    const file = join(workdir, 'state-legacy.json')
    const state = createStateStore({ file })
    await state.write({ lastSession: 'old', sessions: ['old', 'older'] })
    const value = await readSessions(state)
    assert.equal(value.last, 'old')
    assert.deepEqual(value.sessions, ['old', 'older'])
  })
})

describe('skills', () => {
  it('ships 18 parseable skills with no external CLI dependency', async () => {
    const collected = []
    const ctx = {
      skills: {
        register(definition) {
          collected.push(definition)
          return () => {}
        },
      },
      logger: { warn() {}, info() {} },
    }
    const disposers = await registerSkills(ctx, ctx.logger)
    assert.equal(disposers.length, 18)
    assert.equal(collected.length, 18)
    for (const skill of collected) {
      assert.ok(skill.name.startsWith('miloco-'))
      assert.ok(skill.description.length > 20)
      assert.ok(skill.content.length > 200)
      assert.ok(!/openclaw|miloco-cli/i.test(skill.content), `${skill.name} still references an external CLI`)
      assert.ok(!/^\s*你是/m.test(skill.content), `${skill.name} asserts an agent identity`)
    }
  })

  it('parses quoted and unquoted frontmatter', () => {
    const parsed = parseFrontmatter('---\nname: demo\ndescription: "a: b"\nwhenToUse: test\n---\nbody\n')
    assert.equal(parsed.data.name, 'demo')
    assert.equal(parsed.data.description, 'a: b')
    assert.equal(parsed.data.whenToUse, 'test')
    assert.equal(parsed.body, 'body\n')
  })
})

describe('client bundle', () => {
  it('parses as JavaScript (browser bundle has no build step)', () => {
    execFileSync(process.execPath, ['--check', join(ROOT, 'lib/client.js')], { stdio: 'pipe' })
  })

  it('registers the settings tab and never offers a default-model pseudo entry', async () => {
    const source = await readFile(join(ROOT, 'lib/client.js'), 'utf8')
    assert.ok(source.includes('settings.plugins.tab'))
    assert.ok(source.includes("'/dsh-miloco-bridge/api'"))
    assert.ok(source.includes('跟随对话') || source.includes('跟随该对话'))
    assert.ok(!source.includes('默认模型'))
    assert.ok(!source.includes('mode=conversation'))
    assert.ok(!source.includes('聊天模式'))
    assert.ok(!source.includes('动真格'))
    assert.ok(source.includes('一键部署 Miloco'))
    assert.ok(source.includes('连接已有的 Miloco'))
    assert.ok(source.includes('查看模式说明与用法'))
    assert.ok(source.includes('卸载 Miloco'))
    assert.ok(source.includes("rel: 'noopener noreferrer'"))
    assert.ok(source.includes('跟随模型默认'))
    assert.ok(source.includes('effortOptions'))
    assert.ok(source.includes('感知等级'))
    assert.ok(source.includes('installPresetGuide'))
    assert.ok(source.includes('dsh-miloco-preset-helpbar'))
    assert.ok(source.includes('input[type="radio"]'))
    assert.ok(source.includes('flex: 0 0 auto'))
    assert.ok(source.includes('仅高优先级'))
    assert.ok(!source.includes('插件完全不改会话模型'))
  })
})

describe('adapter', () => {
  it('compiles as standalone Python', () => {
    execFileSync('python3', [
      '-c',
      'import pathlib, sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec")',
      join(ROOT, 'adapter/dsh_adapter.py'),
    ], { stdio: 'pipe' })
  })

  it('is self-contained (no vendored Miloco imports)', async () => {
    const source = await readFile(join(ROOT, 'adapter/dsh_adapter.py'), 'utf8')
    assert.ok(source.includes('class Adapter'))
    assert.ok(source.includes('async def send_turn'))
    assert.ok(source.includes('async def read_trace_meta'))
    assert.ok(source.includes('payload["urgency"]'))
    assert.ok(!/from miloco\.(?!agent_platform\.base)/.test(source))
  })
})
