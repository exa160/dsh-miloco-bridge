#!/usr/bin/env node
/**
 * Offline self-check. Runs without DSH and without Miloco.
 *
 * Usage: node tools/selftest.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as infra from '../lib/index.js'
import * as toolsHalf from '../lib/tools-entry.js'
import { createMilocoTools } from '../lib/tools.js'
import { createMilocoClient } from '../lib/miloco-client.js'
import { createOverlay, normalizeOverlay } from '../lib/overlay.js'
import { parseUrgency, perceptionAllowed } from '../lib/perception.js'
import { createStateStore, noteSession, readSessions } from '../lib/state.js'
import { createPushService } from '../lib/push.js'
import { registerSkills, parseFrontmatter } from '../lib/skills.js'

const failures = []
const workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-selftest-'))

async function check(name, fn) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

await check('infra config', () => {
  const config = infra.normalizeConfig({})
  assert.equal(config.push.path, '/miloco/webhook')
  assert.equal(config.push.target.agentPreset, 'miloco')
  assert.equal(config.readOnly, true)
  assert.ok(config.deploy.repo.startsWith('https://'))
})

await check('tool config', () => {
  const config = toolsHalf.normalizeConfig({})
  assert.equal(config.readOnly, true)
  assert.equal(config.push.path, '/miloco/webhook')
})

await check('tool counts', () => {
  const client = createMilocoClient({})
  assert.equal(createMilocoTools({ client, readOnly: true }).length, 30)
  assert.equal(createMilocoTools({ client, readOnly: false }).length, 53)
})

await check('overlay shape', () => {
  const value = normalizeOverlay({
    connection: { baseUrl: 'http://x', token: 't' },
    push: { token: 'p', target: { sessionId: 's' }, model: { provider: 'p', model: 'm' } },
  })
  assert.equal(value.connection.baseUrl, 'http://x')
  assert.equal(value.push.token, 'p')
  assert.equal(value.push.target.sessionId, 's')
  assert.equal(value.push.perception.minLevel, 'all')
})

await check('perception filter', () => {
  assert.equal(parseUrgency({ message: '事件优先级：low\n事件优先级：high' }), 'high')
  assert.equal(perceptionAllowed('low', 'medium'), false)
  assert.equal(perceptionAllowed('', 'high'), true)
})

await check('state', async () => {
  const state = createStateStore({ file: join(workdir, 'state.json') })
  await noteSession(state, 'a')
  await noteSession(state, 'b')
  const value = await readSessions(state)
  assert.equal(value.last, 'b')
  assert.deepEqual(value.sessions, ['b', 'a'])
})

await check('push target: last session, model untouched', async () => {
  const overlay = createOverlay({ file: join(workdir, 'overlay.json') })
  await overlay.write({ push: { token: 't', target: { sessionId: '' }, model: {} } })
  const calls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    sessionController: {
      async resolveAgent() { return {} },
      async create(request) { calls.push(['create', request.sessionId]); return { sessionId: request.sessionId } },
      async selectModel() { calls.push(['selectModel']) },
      async prompt(request) { calls.push(['prompt', request.sessionId]) },
    },
    on() { return () => {} },
  }
  const service = createPushService({
    ctx,
    config: { push: { enabled: true, path: '/p', token: 't', waitForResult: false, target: { sessionId: '' }, model: {} } },
    overlay,
    agentPreset: 'miloco',
    activity: { last: async () => 'last-session' },
  })
  const result = await service.deliver({ message: 'hi' })
  assert.equal(result.sessionId, 'last-session')
  assert.equal(result.source, 'last-miloco-session')
  assert.ok(!calls.some(call => call[0] === 'selectModel'))
})

await check('skills', async () => {
  const collected = []
  const ctx = { skills: { register(d) { collected.push(d); return () => {} } }, logger: { warn() {} } }
  const disposers = await registerSkills(ctx, ctx.logger)
  assert.equal(disposers.length, 18)
  for (const skill of collected) {
    assert.ok(!/openclaw|miloco-cli/i.test(skill.content))
  }
  const parsed = parseFrontmatter('---\nname: x\ndescription: y\n---\nbody')
  assert.equal(parsed.data.name, 'x')
})

await check('client bundle', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('settings.plugins.tab'))
  assert.ok(source.includes('/dsh-miloco-bridge/api'))
  assert.ok(!source.includes('默认模型'))
})

await rm(workdir, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部自检通过。')
