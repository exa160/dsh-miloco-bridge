import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { registerSettingsApi, SETTINGS_PREFIX } from '../lib/settings-api.js'
import { createHomeService } from '../lib/home.js'
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
async function fixture(options = {}) {
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
      async resolveAgent(id) {
        return id === 'miloco-archive'
          ? { agent: { session: { header: { id } } } }
          : { error: Object.assign(new Error('not found'), { code: 'session/not-found' }) }
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

  const client = createMilocoClient({ baseUrl: options.milocoBaseUrl || miloco.baseUrl, timeoutMs: 5_000, home: workdir, overlay })
  const written = []
  const upgradeCalls = []
  const deploy = {
    state: () => ({ running: false, step: 'idle', sourceDir: '/tmp/src', milocoHome: workdir }),
    tail: async () => '',
    start: async () => ({ started: true }),
    upgradeState: () => ({ running: false, step: 'idle', startedAt: null, exitCode: null }),
    startUpgrade: async opts => {
      upgradeCalls.push(opts)
      return { started: true, logPath: '/tmp/upgrade.log' }
    },
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
  const homeDir = join(workdir, 'home-workspace')
  const registryItems = []
  const home = createHomeService({
    ctx: {
      logger: ctx.logger,
      get(name) {
        if (name !== 'workspaceRegistry') return undefined
        return {
          async create(path, title) {
            const found = registryItems.find(item => item.path === path)
            if (found) return found
            const workspace = {
              id: `ws-${registryItems.length + 1}`,
              path,
              title,
              async setTitle(next) { this.title = next },
            }
            registryItems.push(workspace)
            return workspace
          },
          list() { return registryItems },
          async insertBefore() {},
        }
      },
    },
    config: { workspace: { dir: homeDir, title: '家庭助手', agentPreset: 'miloco' } },
    overlay,
    logger: ctx.logger,
  })
  const dispose = registerSettingsApi({
    ctx,
    config: {
      readOnly: false,
      home: workdir,
      deploy: { sourceDir: '/tmp/xiaomi-miloco', ...(options.deploy ?? {}) },
      push: { enabled: true, path: '/miloco/webhook', token: '', waitForResult: true },
      profilePatch: '',
    },
    client,
    overlay,
    state,
    deploy,
    uninstall,
    home,
    writeConfig: async values => { written.push(values); return { ok: true, changed: ['baseUrl', 'token'], missing: [] } },
    logger: ctx.logger,
  })
  return { routes, ctx, client, overlay, state, deploy, upgradeCalls, uninstall, uninstallCalls, written, home, dispose }
}

describe('settings API', () => {
  it('registers every route', async () => {
    const { routes } = await fixture()
    for (const path of ['/status', '/home', '/home/overview', '/sessions', '/target', '/mode', '/deploy', '/connect', '/uninstall', '/version', '/upgrade', '/upgrade/status']) {
      assert.ok(routes.has(`${SETTINGS_PREFIX}${path}`), `missing ${path}`)
    }
  })

  it('home route exposes the workspace path, id, title, preset and archive session', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/home`), { method: 'GET' })
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.path, join(workdir, 'home-workspace'))
    assert.equal(response.body.workspaceId, 'ws-1')
    assert.equal(response.body.title, '家庭助手')
    assert.equal(response.body.dirSource, 'config')
    assert.equal(response.body.archiveSessionId, 'miloco-archive')
  })

  it('home route refuses other methods', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/home`), { method: 'PUT', body: {} })
    assert.equal(response.status, 405)
    assert.equal(response.body.ok, false)
  })

  it('home route changes the directory through the overlay', async () => {
    const { routes, overlay } = await fixture()
    const next = join(workdir, 'home-changed')
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/home`), { body: { dir: next } })
    assert.equal(response.status, 200)
    assert.equal(response.body.previousPath, join(workdir, 'home-workspace'))
    assert.equal(response.body.path, next)
    assert.equal((await overlay.current()).home.dir, next)
  })

  it('home route rejects a relative directory', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/home`), { body: { dir: 'relative/home' } })
    assert.equal(response.status, 400)
  })

  it('overview aggregates devices, events, push log and archive state', async () => {
    const backend = await createFakeMiloco({
      '/api/miot/device_list': {
        code: 0,
        data: [
          { did: 'd1', name: '灯', online: true, room_name: '客厅', model: 'm1' },
          { did: 'd2', name: '插座', online: false, room_name: '客厅', model: 'm2' },
          { did: 'd3', name: '门锁', online: true, room_name: '', model: 'm3' },
        ],
      },
      '/api/events': { code: 0, data: [{ type: 'motion', source: 'cam1', timestamp: 1 }] },
    })
    try {
      const { routes } = await fixture({ milocoBaseUrl: backend.baseUrl })
      const response = await invoke(routes.get(`${SETTINGS_PREFIX}/home/overview`), { method: 'GET' })
      assert.equal(response.status, 200)
      assert.equal(response.body.ok, true)
      assert.equal(response.body.home.archive.sessionId, 'miloco-archive')
      assert.equal(response.body.home.archive.exists, true)
      assert.equal(response.body.devices.total, 3)
      assert.equal(response.body.devices.online, 2)
      assert.equal(response.body.devices.rooms.find(room => room.name === '客厅').total, 2)
      assert.equal(response.body.devices.rooms.find(room => room.name === '未分组').total, 1)
      assert.equal(response.body.events.items[0].type, 'motion')
      assert.deepEqual(response.body.pushes.items, [])
      assert.equal(response.body.version.current, '2026.10.16')
      assert.equal(response.body.push.path, '/miloco/webhook')
    } finally {
      await backend.close()
    }
  })

  it('overview keeps one failing section from blanking the others', async () => {
    const backend = await createFakeMiloco({ '/api/events': { __status: 500 } })
    try {
      const { routes } = await fixture({ milocoBaseUrl: backend.baseUrl })
      const response = await invoke(routes.get(`${SETTINGS_PREFIX}/home/overview`), { method: 'GET' })
      assert.equal(response.status, 200)
      assert.equal(response.body.devices.ok, true)
      assert.equal(response.body.events.ok, false)
      assert.equal(response.body.push.path, '/miloco/webhook')
    } finally {
      await backend.close()
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

  it('target saves the push mode and still preserves the household directory', async () => {
    const { routes, overlay } = await fixture()
    await invoke(routes.get(`${SETTINGS_PREFIX}/home`), { body: { dir: join(workdir, 'home-keep') } })
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/target`), {
      body: { mode: 'session', sessionId: 's1', provider: 'prov', model: 'm1', reasoningEffort: 'low', perceptionLevel: 'all' },
    })
    assert.equal(response.status, 200)
    const value = await overlay.current()
    assert.equal(value.push.target.mode, 'session')
    assert.equal(value.push.target.sessionId, 's1')
    assert.equal(value.home.dir, join(workdir, 'home-keep'))
  })

  it('target rejects an unknown mode', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/target`), { body: { mode: 'bogus' } })
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

  it('version route exposes current/latest/deploy kind and git source root', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/version`), { method: 'GET' })
    assert.equal(response.status, 200)
    assert.equal(response.body.version.version, '2026.10.16')
    assert.equal(response.body.upgrade.latest, '2026.10.16')
    assert.equal(response.body.upgrade.deploy_kind, 'release')
    assert.ok(response.body.sourceRoot.endsWith('xiaomi-miloco'))
    assert.equal(response.body.upgradeStatus.phase, 'idle')
  })

  it('falls back to a GitHub mirror when the backend cannot reach GitHub', async () => {
    const backend = await createFakeMiloco({
      '/api/admin/version': { code: 0, data: { version: '2026.9.11', git: { commit_short: 'old', dirty: false } } },
      '/api/admin/upgrade/check': {
        code: 0,
        data: { current: '2026.9.11', latest: null, has_update: false, deploy_kind: 'release', reachable: false },
      },
    })
    const mirror = await createFakeMiloco({
      '/https://api.github.invalid/repos/XiaoMi/xiaomi-miloco/releases/latest': {
        tag_name: 'v2026.10.16',
        html_url: 'https://github.com/XiaoMi/xiaomi-miloco/releases/tag/v2026.10.16',
      },
    })
    try {
      const { routes, dispose } = await fixture({
        milocoBaseUrl: backend.baseUrl,
        deploy: { githubApi: 'https://api.github.invalid', githubMirrors: [mirror.baseUrl] },
      })
      const response = await invoke(routes.get(`${SETTINGS_PREFIX}/version`), { method: 'GET' })
      assert.equal(response.status, 200)
      assert.equal(response.body.upgrade.source, 'mirror')
      assert.equal(response.body.upgrade.latest, '2026.10.16')
      assert.equal(response.body.upgrade.has_update, true)
      assert.ok(response.body.upgrade.release_url.startsWith(mirror.baseUrl))
      dispose()
    } finally {
      await backend.close()
      await mirror.close()
    }
  })

  it('starts a plugin-side upgrade after a mirror check', async () => {
    const backend = await createFakeMiloco({
      '/api/admin/version': { code: 0, data: { version: '2026.9.11', git: { commit_short: 'old', dirty: false } } },
      '/api/admin/upgrade/check': {
        code: 0,
        data: { current: '2026.9.11', latest: null, has_update: false, deploy_kind: 'release', reachable: false },
      },
    })
    const mirror = await createFakeMiloco({
      '/https://api.github.invalid/repos/XiaoMi/xiaomi-miloco/releases/latest': {
        tag_name: 'v2026.10.16',
        html_url: 'https://github.com/XiaoMi/xiaomi-miloco/releases/tag/v2026.10.16',
      },
    })
    try {
      const { routes, deploy, upgradeCalls, dispose } = await fixture({
        milocoBaseUrl: backend.baseUrl,
        deploy: { githubApi: 'https://api.github.invalid', githubMirrors: [mirror.baseUrl] },
      })
      await invoke(routes.get(`${SETTINGS_PREFIX}/version`), { method: 'GET' })
      const response = await invoke(routes.get(`${SETTINGS_PREFIX}/upgrade`), { body: {} })
      assert.equal(response.status, 200)
      assert.equal(response.body.source, 'plugin')
      assert.equal(upgradeCalls.length, 1)
      deploy.upgradeState = () => ({ running: true, step: 'installing', startedAt: 'now', exitCode: null })
      const status = await invoke(routes.get(`${SETTINGS_PREFIX}/upgrade/status`), { method: 'GET' })
      assert.equal(status.body.source, 'plugin')
      assert.equal(status.body.status.phase, 'installing')
      dispose()
    } finally {
      await backend.close()
      await mirror.close()
    }
  })

  it('upgrade route proxies the upstream one-click upgrade', async () => {
    const { routes } = await fixture()
    const response = await invoke(routes.get(`${SETTINGS_PREFIX}/upgrade`), { body: {} })
    assert.equal(response.status, 200)
    assert.equal(response.body.data.started, true)
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
