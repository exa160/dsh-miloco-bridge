import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { registerSettingsApi, SETTINGS_PREFIX } from '../lib/settings-api.js'
import { createMilocoClient } from '../lib/miloco-client.js'
import { createOverlay } from '../lib/overlay.js'
import { createStateStore, noteSession } from '../lib/state.js'
import { createFakeMiloco, invoke } from './helpers.js'

let workdir
let miloco
before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-settings-'))
  miloco = await createFakeMiloco()
})
after(async () => {
  await miloco.close()
  await rm(workdir, { recursive: true, force: true })
})

/**
 * Build the settings API with fake host services.
 * @returns {Promise<any>} Fixture.
 */
async function fixture() {
  const overlay = createOverlay({ file: join(workdir, `overlay-${Math.random().toString(16).slice(2)}.json`) })
  await overlay.write({
    connection: { baseUrl: '', token: '' },
    push: {
      token: 'push-token',
      target: { sessionId: '' },
      model: { provider: '', model: '', reasoningEffort: '' },
    },
  })
  const state = createStateStore({ file: join(workdir, `state-${Math.random().toString(16).slice(2)}.json`) })
  await noteSession(state, 's1')

  const routes = new Map()
  const liveSession = { id: 's1', header: { id: 's1', cwd: '/workspace', agentPreset: 'miloco' } }
  const archived = { id: 's0', header: { id: 's0', cwd: '/workspace', agentPreset: 'standard' } }
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    sessionController: {
      async modelCatalog() {
        return {
          groups: [{ id: 'prov', name: 'Provider', models: [{ id: 'm1', name: 'Model 1', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }] }],
          failures: [],
          default: { provider: 'prov', model: 'm1' },
        }
      },
    },
    sessions: { list: () => [liveSession, archived] },
    sessionTitle: { get: session => ({ title: session.id === 's1' ? '家庭群' : '普通对话' }) },
    get(name) {
      if (name === 'sessions') return this.sessions
      if (name === 'sessionTitle') return this.sessionTitle
      return undefined
    },
  }

  const client = createMilocoClient({ baseUrl: miloco.baseUrl, timeoutMs: 5_000, home: workdir, overlay })
  const written = []
  const deploy = {
    state: () => ({ running: false, step: 'idle', sourceDir: '/tmp/src', milocoHome: workdir }),
    tail: async () => '',
    start: async () => ({ started: true }),
  }
  const uninstallCalls = []
  const uninstall = {
    preview: () => ({ milocoHome: workdir, sourceDir: '/tmp/src', adapterDir: '/tmp/adapter' }),
    run: async opts => {
      uninstallCalls.push(opts)
      if (opts.confirm !== 'UNINSTALL') throw new Error('确认文本必须是 UNINSTALL')
      return { ok: true, note: 'uninstalled' }
    },
  }
  const dispose = registerSettingsApi({
    ctx,
    config: {
      readOnly: false,
      home: workdir,
      push: { enabled: true, path: '/miloco/webhook', token: '', waitForResult: true },
      profilePatch: '',
    },
    client,
    overlay,
    state,
    deploy,
    uninstall,
    writeConfig: async values => { written.push(values); return { ok: true, changed: ['baseUrl', 'token'], missing: [] } },
    logger: ctx.logger,
  })
  return { routes, ctx, client, overlay, state, deploy, uninstall, uninstallCalls, written, dispose }
}

describe('settings API', () => {
  it('registers every route', async () => {
    const { routes } = await fixture()
    for (const path of ['/status', '/sessions', '/target', '/mode', '/deploy', '/connect', '/uninstall']) {
      assert.ok(routes.has(`${SETTINGS_PREFIX}${path}`), `missing ${path}`)
    }
  })

  it('status reports household overview, conversations and no default-model field', async () => {
    const { routes, dispose } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/status`), { method: 'GET' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.overview.account.nickname, 'TestUser')
    assert.equal(response.body.overview.deviceCount, 2)
    assert.equal(response.body.overview.cameraCount, 1)
    assert.equal(response.body.overview.perceptionRunning, true)
    assert.equal(response.body.overview.tokenTotal, 150)
    assert.equal(response.body.sessions.find(item => item.id === 's1').title, '家庭群')
    assert.equal(response.body.lastMilocoSession, 's1')
    assert.equal('defaultModel' in response.body, false)
    assert.equal(response.body.overlay.connection.tokenSet, false)
    assert.equal(response.body.overlay.push.tokenSet, true)
    assert.equal(response.body.push.tokenSet, true)
    assert.deepEqual(response.body.providers[0].models[0].reasoning.efforts.map(item => item.id), ['low', 'high'])
    assert.equal(response.body.push.perception.minLevel, 'all')
    assert.equal(response.body.overlay.push.perception.minLevel, 'all')
    dispose()
  })

  it('sessions route exposes live and remembered conversations', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/sessions`), { method: 'GET' })
    assert.equal(response.status, 200)
    assert.ok(response.body.sessions.some(item => item.id === 's1' && item.lastMiloco))
    assert.ok(response.body.sessions.some(item => item.id === 's0'))
  })

  it('target preserves connection and push token', async () => {
    const { routes, overlay } = await fixture()
    await overlay.write({
      connection: { baseUrl: miloco.baseUrl, token: 'conn' },
      push: {
        token: 'push-token',
        target: { sessionId: '' },
        model: { provider: '', model: '', reasoningEffort: '' },
      },
    })
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/target`), {
      body: { sessionId: 's1', provider: 'prov', model: 'm1', reasoningEffort: 'low', perceptionLevel: 'high' },
    })
    assert.equal(response.status, 200)
    const value = await overlay.current()
    assert.equal(value.connection.baseUrl, miloco.baseUrl)
    assert.equal(value.connection.token, 'conn')
    assert.equal(value.push.token, 'push-token')
    assert.equal(value.push.target.sessionId, 's1')
    assert.equal(value.push.model.model, 'm1')
    assert.equal(value.push.perception.minLevel, 'high')
  })

  it('target rejects an unknown perception level', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/target`), {
      body: { perceptionLevel: 'urgent' },
    })
    assert.equal(response.status, 400)
  })

  it('target rejects a half model selection', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/target`), {
      body: { provider: 'prov' },
    })
    assert.equal(response.status, 400)
  })

  it('connect applies immediately and persists to the profile when possible', async () => {
    const { routes, client, overlay, written } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/connect`), {
      body: { baseUrl: miloco.baseUrl, token: 'conn-token', pushToken: 'new-push' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.reachable, true)
    assert.equal(response.body.applied, true)
    const value = await overlay.current()
    assert.equal(value.connection.baseUrl, miloco.baseUrl)
    assert.equal(value.connection.token, 'conn-token')
    assert.equal(value.push.token, 'new-push')
    const endpoint = await client.endpoint()
    assert.equal(endpoint.source, 'overlay')
    assert.equal(endpoint.baseUrl, miloco.baseUrl)
    assert.equal(written.length, 1)
  })

  it('connect rejects non-http URLs and credentials', async () => {
    const { routes } = await fixture()
    const bad = await invoke(routes.get(`${SETTINGS_PREFIX}/connect`), {
      body: { baseUrl: 'file:///etc/passwd' },
    })
    assert.equal(bad.status, 400)
    const creds = await invoke(routes.get(`${SETTINGS_PREFIX}/connect`), {
      body: { baseUrl: 'http://user:pass@127.0.0.1:1810' },
    })
    assert.equal(creds.status, 400)
  })

  it('mode rejects unknown values', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/mode`), { body: { mode: 'root' } })
    assert.equal(response.status, 400)
  })

  it('uninstall previews and requires the literal confirmation', async () => {
    const { routes, uninstallCalls } = await fixture()
    const preview = await invoke(routes.get(`${SETTINGS_PREFIX}/uninstall`), { method: 'GET' })
    assert.equal(preview.status, 200)
    assert.equal(preview.body.preview.milocoHome, workdir)

    const wrong = await invoke(routes.get(`${SETTINGS_PREFIX}/uninstall`), {
      body: { confirm: 'yes', removeData: false, removeSource: false },
    })
    assert.equal(wrong.status, 400)

    const ok = await invoke(routes.get(`${SETTINGS_PREFIX}/uninstall`), {
      body: { confirm: 'UNINSTALL', removeData: true, removeSource: true },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.note, 'uninstalled')
    assert.deepEqual(uninstallCalls.at(-1), { confirm: 'UNINSTALL', removeData: true, removeSource: true })
  })
})
