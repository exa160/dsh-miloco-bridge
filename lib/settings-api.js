/**
 * Host-side settings API for the Web GUI.
 *
 * The browser half renders a tab under 「设置 → 插件」. It talks to these raw
 * `ctx.webServer` routes instead of editing YAML.
 *
 * Routes:
 *   GET  /dsh-miloco-bridge/api/status      mode, connection, overview, sessions
 *   GET  /dsh-miloco-bridge/api/sessions    live DSH conversations
 *   POST /dsh-miloco-bridge/api/target      push destination (session + model)
 *   POST /dsh-miloco-bridge/api/mode        readonly / full
 *   GET  /dsh-miloco-bridge/api/deploy      deployment state + log
 *   POST /dsh-miloco-bridge/api/deploy      start one-click deployment
 *   POST /dsh-miloco-bridge/api/connect     connect an existing Miloco
 *   GET  /dsh-miloco-bridge/api/uninstall   uninstall preview
 *   POST /dsh-miloco-bridge/api/uninstall   stop/remove Miloco (confirm=UNINSTALL)
 *
 * Mutations enforce same-origin. Tokens are never echoed back to the browser.
 *
 * @module dsh-miloco-bridge/settings-api
 */

import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fetchLatestRelease, inferDeployKind, isNewerRelease, normalizeReleaseVersion } from './github-release.js'
import { MilocoError, readMilocoConfig } from './miloco-client.js'
import { normalizePerceptionLevel, PERCEPTION_LEVELS } from './perception.js'
import { AGENT_MODES, describeMode, readSessions } from './state.js'

/** Prefix shared by every settings route. */
export const SETTINGS_PREFIX = '/dsh-miloco-bridge/api'

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @param {number} limit - Maximum accepted body size in bytes.
 * @returns {Promise<string>} The body text.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Answer with a JSON body.
 * @param {import('node:http').ServerResponse} res - The response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serialisable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Enforce same-origin for browser-initiated mutations.
 *
 * A request without an `Origin` header is a non-browser client (curl, tests)
 * and is allowed. A request with one must match the host it addressed.
 *
 * @param {import('node:http').IncomingMessage} req - The request.
 * @returns {boolean} Whether the request may proceed.
 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Strip secrets before sending an overlay to the browser.
 * @param {any} overlay - Normalised overlay.
 * @returns {any} Sanitised overlay.
 */
export function publicOverlay(overlay) {
  return {
    connection: {
      baseUrl: overlay?.connection?.baseUrl ?? '',
      tokenSet: Boolean(overlay?.connection?.token),
    },
    push: {
      tokenSet: Boolean(overlay?.push?.token),
      target: { sessionId: overlay?.push?.target?.sessionId ?? '' },
      model: {
        provider: overlay?.push?.model?.provider ?? '',
        model: overlay?.push?.model?.model ?? '',
        reasoningEffort: overlay?.push?.model?.reasoningEffort ?? '',
      },
      perception: {
        minLevel: normalizePerceptionLevel(overlay?.push?.perception?.minLevel),
      },
    },
  }
}

/**
 * Read the live model catalog. No "deployment default" pseudo-entry is
 * exposed: an empty model selection means "follow the conversation".
 * @param {any} ctx - Host context.
 * @returns {Promise<{providers: any[], failures: any[]}>} The catalog.
 */
async function readCatalog(ctx) {
  try {
    const catalog = await ctx.sessionController.modelCatalog()
    return {
      providers: (catalog?.groups ?? []).map(group => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map(model => ({
          id: model.id,
          name: model.name,
          description: model.description,
          ...(model.reasoning ? { reasoning: model.reasoning } : {}),
        })),
      })),
      failures: catalog?.failures ?? [],
    }
  } catch (error) {
    return {
      providers: [],
      failures: [{ message: error instanceof Error ? error.message : String(error) }],
    }
  }
}

/**
 * List DSH conversations for the target dropdown.
 *
 * Live sessions come from `ctx.sessions.list()`; titles come from
 * `ctx.sessionTitle.get(session)` when that service is mounted. Sessions that
 * previously touched Miloco but are no longer live are appended from the
 * state file so a remembered target stays selectable.
 *
 * @param {any} ctx - Host context.
 * @param {any} state - Shared state store.
 * @returns {Promise<{sessions: any[], last: string}>} The sessions and last Miloco session.
 */
async function listSessions(ctx, state) {
  const recent = state ? await readSessions(state) : { last: '', sessions: [], entries: [] }
  const sessions = ctx.get?.('sessions') ?? ctx.sessions
  const titles = ctx.get?.('sessionTitle') ?? ctx.sessionTitle
  const seen = new Set()
  const rows = []

  const live = typeof sessions?.list === 'function' ? sessions.list() : []
  for (const session of live) {
    const id = session?.id
    if (typeof id !== 'string' || !id || seen.has(id)) continue
    if (session?.header?.origin === 'subagent') continue
    seen.add(id)
    let title = ''
    try {
      title = titles?.get?.(session)?.title ?? ''
    } catch {
      title = ''
    }
    rows.push({
      id,
      title,
      cwd: session?.header?.cwd ?? '',
      agentPreset: session?.header?.agentPreset ?? '',
      live: true,
      lastMiloco: id === recent.last,
    })
  }
  for (const entry of recent.entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    rows.push({
      id: entry.id,
      title: '',
      cwd: '',
      agentPreset: '',
      live: false,
      lastMiloco: entry.id === recent.last,
      lastAt: entry.at || null,
    })
  }
  return { sessions: rows.slice(0, 100), last: recent.last }
}

/**
 * Register the settings routes on the host web server.
 *
 * @param {{ctx: any, config: any, client: any, overlay: any, state?: any, deploy?: any, writeConfig?: any, logger?: any}} options - Service options.
 * @returns {() => void} A disposer removing every route.
 */
export function registerSettingsApi(options) {
  const { ctx, config, client, overlay } = options
  const log = options.logger ?? ctx.logger
  const disposers = []
  /** @type {null | {at: number, source: string, has_update: boolean, current: string, latest: string}} */
  let lastUpgradeCheck = null

  /**
   * Register one exact route.
   * @param {string} path - Route path.
   * @param {(req: any, res: any) => Promise<void>} handler - Request handler.
   */
  const route = (path, handler) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log?.warn?.(`dsh-miloco-bridge: settings route ${path} failed: ${message}`)
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: message })
        }
      },
    }))
  }

  /**
   * Parse a JSON body for a mutating route.
   * @param {any} req - The request.
   * @param {any} res - The response.
   * @returns {Promise<any | null>} Parsed body or null when a response was sent.
   */
  async function mutateBody(req, res) {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      return null
    }
    try {
      const text = await readBody(req, 256 * 1024)
      return text ? JSON.parse(text) : {}
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `invalid JSON body: ${error instanceof Error ? error.message : error}` })
      return null
    }
  }

  route(`${SETTINGS_PREFIX}/status`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const endpoint = await client.endpoint()
    const current = await overlay.current()
    const sessionList = await listSessions(ctx, options.state)
    const persisted = options.state ? await options.state.read().catch(() => ({})) : {}
    const mode = typeof persisted.mode === 'string'
      ? persisted.mode
      : (config.readOnly === false ? 'full' : 'readonly')
    const catalog = await readCatalog(ctx)
    const milocoConfig = await readMilocoConfig(endpoint.home)
    const agentPlatform = String(milocoConfig?.agent?.platform ?? '')
    let adapterInstalled = false
    try {
      await access(join(endpoint.home, 'agent_platform', 'dsh', 'adapter.py'))
      adapterInstalled = true
    } catch {
      adapterInstalled = false
    }

    let backend = { reachable: false }
    let overview = null
    try {
      const status = await client.get('/api/admin/status', { signal: AbortSignal.timeout(8_000) })
      backend = {
        reachable: true,
        miot: status?.miot ?? null,
        perception: status?.perception ?? null,
        ruleEngine: status?.rule_engine ?? null,
        sqlite: status?.sqlite ?? null,
      }
    } catch (error) {
      backend = {
        reachable: false,
        error: error instanceof MilocoError ? error.message : String(error),
      }
    }

    if (backend.reachable) {
      const short = AbortSignal.timeout(8_000)
      const [user, devices, cameras, rules, tasks, engine, usage] = await Promise.all([
        client.get('/api/miot/user_info', { signal: short }).catch(() => null),
        client.get('/api/miot/device_list', { signal: short }).catch(() => null),
        client.get('/api/miot/camera_list', { signal: short }).catch(() => null),
        client.get('/api/rules', { signal: short }).catch(() => null),
        client.get('/api/tasks', { signal: short }).catch(() => null),
        client.get('/api/perception/engine/status', { signal: short }).catch(() => null),
        client.get('/api/admin/token-usage', { query: { limit: 500 }, signal: short }).catch(() => null),
      ])
      const usageRows = Array.isArray(usage?.events) ? usage.events : []
      const sumField = field => usageRows.reduce(
        (sum, row) => sum + (Number(row?.[field] ?? 0) || 0),
        0,
      )
      const tokenInput = sumField('input_tokens')
      const tokenOutput = sumField('output_tokens')
      const tokenTotal = tokenInput + tokenOutput
        + sumField('cache_tokens')
        + sumField('video_tokens')
        + sumField('audio_tokens')
      overview = {
        account: user?.nickname ? { nickname: user.nickname, uid: user.uid ?? null } : null,
        accountBound: Boolean(user?.uid),
        deviceCount: Array.isArray(devices) ? devices.length : null,
        cameraCount: Array.isArray(cameras) ? cameras.length : null,
        ruleCount: Array.isArray(rules) ? rules.length : null,
        taskCount: Array.isArray(tasks) ? tasks.length : null,
        perceptionRunning: Boolean(engine?.running),
        perceptionSources: Array.isArray(engine?.active_sources) ? engine.active_sources.length : null,
        tokenEvents: Number.isFinite(usage?.total) ? usage.total : usageRows.length,
        tokenInput: tokenInput || null,
        tokenOutput: tokenOutput || null,
        tokenTotal: tokenTotal || null,
        lastInferenceCount: engine?.today_inference_count ?? null,
      }
    }

    const effectivePushToken = String(current.push.token || config.push.token || '')

    sendJson(res, 200, {
      ok: true,
      packageName: 'dsh-miloco-bridge',
      mode: describeMode(mode),
      modes: AGENT_MODES.map(id => describeMode(id)),
      readOnly: config.readOnly,
      readOnlyNote: '模式在插件激活时读取，改动需要重启 DSH（或重新挂载该预设）才生效。',
      connection: {
        baseUrl: endpoint.baseUrl,
        source: endpoint.source,
        tokenSet: Boolean(endpoint.token),
        home: endpoint.home,
      },
      backend: {
        ...backend,
        baseUrl: endpoint.baseUrl,
        home: endpoint.home,
      },
      adapter: {
        installed: adapterInstalled,
        agentPlatform,
        active: agentPlatform === 'dsh',
      },
      push: {
        enabled: config.push.enabled,
        path: config.push.path,
        tokenSet: Boolean(effectivePushToken),
        waitForResult: config.push.waitForResult,
        perception: {
          minLevel: normalizePerceptionLevel(
            current.push?.perception?.minLevel || config.push?.perception?.minLevel,
          ),
          levels: PERCEPTION_LEVELS,
        },
      },
      overlayFile: overlay.file,
      overlay: publicOverlay(current),
      overview,
      sessions: sessionList.sessions,
      lastMilocoSession: sessionList.last,
      providers: catalog.providers,
      failures: catalog.failures,
      deploy: options.deploy ? options.deploy.state() : null,
      configLocation: {
        profile: '~/.dsh/profiles/<profile>/cordis.patch.yml',
        bundle: '插件自带的 cordis.patch.yml（提供默认 config）',
        runtime: overlay.file,
      },
    })
  })

  route(`${SETTINGS_PREFIX}/sessions`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const sessions = await listSessions(ctx, options.state)
    sendJson(res, 200, { ok: true, ...sessions })
  })

  route(`${SETTINGS_PREFIX}/target`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await mutateBody(req, res)
    if (body === null) return

    const current = await overlay.current()
    const sessionId = typeof body.sessionId === 'string'
      ? body.sessionId.trim()
      : current.push.target.sessionId
    const provider = typeof body.provider === 'string'
      ? body.provider.trim()
      : current.push.model.provider
    const model = typeof body.model === 'string'
      ? body.model.trim()
      : current.push.model.model
    const reasoningEffort = typeof body.reasoningEffort === 'string'
      ? body.reasoningEffort.trim()
      : current.push.model.reasoningEffort
    const perceptionLevel = typeof body.perceptionLevel === 'string'
      ? body.perceptionLevel.trim()
      : current.push.perception.minLevel

    if (Boolean(provider) !== Boolean(model)) {
      sendJson(res, 400, { ok: false, error: 'provider 与 model 必须同时选择，或都留空（跟随对话）' })
      return
    }
    if (!PERCEPTION_LEVELS.includes(perceptionLevel)) {
      sendJson(res, 400, {
        ok: false,
        error: `perceptionLevel 只能是 ${PERCEPTION_LEVELS.join(' / ')}`,
      })
      return
    }

    await overlay.write({
      connection: current.connection,
      push: {
        token: current.push.token,
        target: { sessionId },
        model: { provider, model, reasoningEffort },
        perception: { minLevel: perceptionLevel },
      },
    })

    sendJson(res, 200, { ok: true, overlay: publicOverlay(await overlay.current()) })
  })

  route(`${SETTINGS_PREFIX}/mode`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!options.state) {
      sendJson(res, 503, { ok: false, error: '共享状态不可用' })
      return
    }
    const body = await mutateBody(req, res)
    if (body === null) return
    const mode = typeof body.mode === 'string' ? body.mode : ''
    if (!AGENT_MODES.includes(mode)) {
      sendJson(res, 400, { ok: false, error: `mode 只能是 ${AGENT_MODES.join(' / ')}` })
      return
    }
    await options.state.write({ mode })
    sendJson(res, 200, {
      ok: true,
      mode: describeMode(mode),
      note: '已保存。模式在插件激活时读取，重启 DSH（或重新挂载该预设）后生效。',
    })
  })

  route(`${SETTINGS_PREFIX}/version`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const force = new URL(req.url, 'http://127.0.0.1').searchParams.get('refresh') === '1'
    const endpoint = await client.endpoint()
    const fileConfig = await readMilocoConfig(endpoint.home)
    const pythonBin = String(fileConfig?.server?.python_bin ?? '')
    // server.python_bin = <source>/backend/.venv/bin/python
    const sourceRoot = pythonBin
      ? dirname(dirname(dirname(dirname(pythonBin))))
      : (config.deploy?.sourceDir || '')

    try {
      const [version, backendUpgrade, upgradeStatus] = await Promise.all([
        client.get('/api/admin/version', { signal: AbortSignal.timeout(8_000) }),
        client.get('/api/admin/upgrade/check', {
          query: { force: force ? 'true' : 'false' },
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null),
        client.get('/api/admin/upgrade/status', { signal: AbortSignal.timeout(8_000) }).catch(() => null),
      ])
      let upgrade = backendUpgrade
      if (!upgrade || upgrade.reachable === false) {
        const current = String(upgrade?.current || version?.version || '')
        const deployKind = upgrade?.deploy_kind || inferDeployKind(current)
        try {
          const latest = await fetchLatestRelease({
            repo: config.deploy?.repo,
            apiBase: config.deploy?.githubApi,
            mirrors: config.deploy?.githubMirrors,
            timeoutMs: 6_000,
          })
          upgrade = {
            current,
            latest: normalizeReleaseVersion(latest.tag),
            has_update: Boolean(current) && deployKind === 'release'
              && isNewerRelease(current, latest.tag),
            deploy_kind: deployKind,
            release_url: latest.release_url || latest.html_url,
            reachable: true,
            source: latest.source,
            mirror: latest.mirror || null,
            checked_at: Math.floor(Date.now() / 1000),
          }
        } catch (fallbackError) {
          const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          upgrade = {
            ...(upgrade ?? {}),
            current,
            latest: null,
            has_update: false,
            deploy_kind: deployKind,
            release_url: null,
            reachable: false,
            source: 'none',
            error: message,
          }
        }
      } else {
        upgrade = { ...upgrade, source: upgrade.source || 'backend' }
      }
      if (upgrade) {
        lastUpgradeCheck = {
          at: Date.now(),
          source: upgrade.source || 'backend',
          has_update: Boolean(upgrade.has_update),
          current: String(upgrade.current || ''),
          latest: String(upgrade.latest || ''),
        }
      }
      sendJson(res, 200, {
        ok: true,
        reachable: true,
        sourceRoot,
        version,
        upgrade,
        upgradeStatus,
      })
    } catch (error) {
      sendJson(res, 200, {
        ok: true,
        reachable: false,
        sourceRoot,
        error: error instanceof MilocoError ? error.message : String(error),
        version: null,
        upgrade: null,
        upgradeStatus: null,
      })
    }
  })

  route(`${SETTINGS_PREFIX}/upgrade`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await mutateBody(req, res)
    if (body === null) return
    const recent = lastUpgradeCheck && Date.now() - lastUpgradeCheck.at < 10 * 60_000
    const pluginUpgrade = recent
      && lastUpgradeCheck.source !== 'backend'
      && lastUpgradeCheck.has_update
      && typeof options.deploy?.startUpgrade === 'function'
    if (pluginUpgrade) {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
      const origin = typeof req.headers.origin === 'string' && req.headers.origin
        ? req.headers.origin
        : `${proto}://${req.headers.host ?? '127.0.0.1:3080'}`
      const outcome = await options.deploy.startUpgrade({ origin })
      if (!outcome.started) {
        sendJson(res, 409, { ok: false, error: outcome.reason || '升级未启动', ...outcome })
        return
      }
      sendJson(res, 200, { ok: true, source: 'plugin', ...outcome })
      return
    }
    // Upstream only allows /upgrade/run for release deployments. It performs
    // its own has_update check; surface its 400 reason verbatim.
    try {
      const data = await client.post('/api/admin/upgrade/run', undefined, {
        signal: AbortSignal.timeout(30_000),
      })
      sendJson(res, 200, { ok: true, data })
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof MilocoError ? error.message : String(error),
      })
    }
  })

  route(`${SETTINGS_PREFIX}/upgrade/status`, async (req, res) => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const pluginState = options.deploy?.upgradeState?.()
    if (pluginState && pluginState.step !== 'idle') {
      const phaseMap = {
        'downloading-installer': 'downloading',
        'starting-service': 'restarting',
        wiring: 'installing',
      }
      sendJson(res, 200, {
        ok: true,
        source: 'plugin',
        status: { ...pluginState, phase: phaseMap[pluginState.step] || pluginState.step },
      })
      return
    }
    try {
      const status = await client.get('/api/admin/upgrade/status', {
        signal: AbortSignal.timeout(8_000),
      })
      sendJson(res, 200, { ok: true, status })
    } catch (error) {
      sendJson(res, 200, {
        ok: true,
        status: null,
        error: error instanceof MilocoError ? error.message : String(error),
      })
    }
  })

  route(`${SETTINGS_PREFIX}/deploy`, async (req, res) => {
    if (!options.deploy) {
      sendJson(res, 503, { ok: false, error: '部署功能未启用' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        state: options.deploy.state(),
        log: await options.deploy.tail(80),
      })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      return
    }
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
    const requestOrigin = typeof req.headers.origin === 'string' && req.headers.origin
      ? req.headers.origin
      : `${proto}://${req.headers.host ?? '127.0.0.1:3080'}`
    const outcome = await options.deploy.start({ origin: requestOrigin })
    sendJson(res, 200, { ok: true, ...outcome })
  })

  route(`${SETTINGS_PREFIX}/uninstall`, async (req, res) => {
    if (!options.uninstall) {
      sendJson(res, 503, { ok: false, error: '卸载功能未启用' })
      return
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, preview: options.uninstall.preview() })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' })
      return
    }
    const body = await mutateBody(req, res)
    if (body === null) return
    try {
      const result = await options.uninstall.run({
        confirm: typeof body.confirm === 'string' ? body.confirm : '',
        removeData: body.removeData === true,
        removeSource: body.removeSource === true,
      })
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  route(`${SETTINGS_PREFIX}/connect`, async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    const body = await mutateBody(req, res)
    if (body === null) return

    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : ''
    const token = typeof body.token === 'string' ? body.token.trim() : ''
    const pushToken = typeof body.pushToken === 'string' ? body.pushToken.trim() : token
    if (!baseUrl) {
      sendJson(res, 400, { ok: false, error: 'baseUrl 不能为空' })
      return
    }
    let parsed
    try {
      parsed = new URL(baseUrl)
    } catch {
      sendJson(res, 400, { ok: false, error: 'baseUrl 不是合法 URL' })
      return
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      sendJson(res, 400, { ok: false, error: 'baseUrl 只能是 http(s) 且不能包含账号密码' })
      return
    }

    const current = await overlay.current()
    await overlay.write({
      connection: { baseUrl, token },
      push: {
        token: pushToken || current.push.token,
        target: current.push.target,
        model: current.push.model,
        perception: current.push.perception,
      },
    })

    let reachable = false
    let error = ''
    try {
      await client.get('/api/admin/status', { signal: AbortSignal.timeout(8_000) })
      reachable = true
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }

    // Best-effort persistence. The overlay alone is enough for immediate use;
    // writing the profile layer keeps the value across overlay deletion.
    let applied = false
    if (options.writeConfig) {
      try {
        const result = await options.writeConfig({ baseUrl, token })
        applied = result?.ok === true
      } catch {
        applied = false
      }
    }

    sendJson(res, 200, {
      ok: true,
      reachable,
      ...(error ? { error } : {}),
      applied,
      connection: { baseUrl, tokenSet: Boolean(token) },
      note: reachable
        ? '连接成功，立即生效。'
        : '已保存连接信息，但暂时连不上；请确认 Miloco 已启动。',
    })
  })

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch { /* 卸载期忽略 */ }
    }
  }
}
