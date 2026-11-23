/**
 * Miloco -> DSH push delivery.
 *
 * Miloco is the active side of the household brain: it watches cameras,
 * evaluates rules and expires tasks, then asks an Agent to react. This module
 * is the receiving end of that loop.
 *
 * Delivery target rules:
 *
 * 1. `target.mode = 'archive'` (the default) -> the dedicated archive session
 *    `miloco-archive`, created lazily with the household cwd and preset.
 * 2. `target.mode = 'session'` -> `target.sessionId` (overlay, then config);
 *    empty falls back to the session that last touched a Miloco tool, then to
 *    an id derived from Miloco's `sessionKey`.
 * 3. Model not configured -> do not touch the session's model.
 * 4. Model configured -> select it before prompting.
 *
 * Every delivery that resolved a target is recorded in the shared push log
 * (`{at, title, summary, sessionId, status, runId}`); a target-resolution
 * failure is not recorded.
 *
 * The inbound route authenticates with a bearer token. The effective token is
 * `overlay.push.token` or `push.token` from static config; when both are empty
 * every inbound request is refused (fail closed).
 *
 * Two credentials travel in opposite directions and must not be shared:
 * the push token authenticates `Miloco -> DSH`, the backend token
 * authenticates `DSH -> Miloco`. The push token is registered with the host
 * connection as a credential, so a DSH release that requires credentials on
 * HTTP routes still admits Miloco.
 *
 * @module dsh-miloco-bridge/push
 */

import { randomUUID } from 'node:crypto'
import { normalizePushTargetMode } from './overlay.js'
import {
  normalizePerceptionLevel,
  parseUrgency,
  perceptionAllowed,
} from './perception.js'
import { notePush } from './state.js'

/** Default inbound route path. */
export const DEFAULT_PUSH_PATH = '/miloco/webhook'

/** Source kind of a folded Miloco push inside a conversation. */
export const PUSH_SOURCE_KIND = 'miloco-push'

/** The dedicated session inbound pushes land in by default. */
export const ARCHIVE_SESSION_ID = 'miloco-archive'

/** Title of the dedicated archive session. */
export const ARCHIVE_SESSION_TITLE = 'Miloco 推送归档'

/** Maximum length of the one-line summary shown in the folded card. */
const SUMMARY_MAX_CHARS = 120

/** Leading Miloco cron tag: `[cron:<task name>]`. */
const CRON_TAG = /^\[cron:([^\]]+)\]\s*/i

/** How long a delivered idempotency key / run id is remembered. */
const RESULT_TTL_MS = 10 * 60_000

/**
 * Build the one-line title shown while a push stays folded.
 *
 * A cron push is titled `任务推送-<task name>`; every other push is
 * `事件推送-<title or first body line>`. The cron tag itself is stripped.
 *
 * @param {any} payload - The inbound payload.
 * @param {string} message - The push body.
 * @returns {string} A title of at most 120 characters.
 */
export function pushDisplayTitle(payload, message) {
  const title = String(payload?.title ?? '').trim()
  const first = String(message ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
  const candidates = [title, first].filter(Boolean)
  const cronSource = candidates.find(text => CRON_TAG.test(text))
  const match = cronSource ? CRON_TAG.exec(cronSource) : null
  const source = cronSource ?? candidates[0] ?? ''
  const name = (match ? match[1] : source).trim() || 'Miloco 推送'
  const text = `${match ? '任务推送' : '事件推送'}-${name}`
  return text.length > SUMMARY_MAX_CHARS ? `${text.slice(0, SUMMARY_MAX_CHARS - 1)}…` : text
}

/**
 * Derive a stable DSH session id from a Miloco session key.
 *
 * @param {string} sessionKey - Miloco session key (for example `agent:main:miloco`).
 * @returns {string} A filesystem-safe, stable session id.
 */
export function sessionIdForMilocoKey(sessionKey) {
  const slug = String(sessionKey ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `miloco-${slug || 'default'}`
}

/**
 * Read a JSON request body with a size cap.
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
 * Send a JSON response over a raw node response.
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
 * Compare a presented bearer token with the configured one in constant time.
 * @param {string} presented - Token from the request.
 * @param {string} expected - Configured token.
 * @returns {boolean} Whether the tokens match.
 */
function tokenMatches(presented, expected) {
  if (!expected) return false
  if (presented.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Extract a bearer token from the request headers.
 * @param {import('node:http').IncomingMessage} req - The request.
 * @returns {string} The token, or an empty string.
 */
function bearerOf(req) {
  const header = req.headers.authorization
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : ''
}

/**
 * Principal kind of the peer that represents an inbound Miloco push.
 *
 * It is deliberately not `owner`: the push credential only authorises the
 * inbound route, never the owner's API surface.
 */
export const PUSH_PRINCIPAL_KIND = 'miloco-push'

/**
 * Extract the request path of an admission fact bundle.
 *
 * The host hands providers a fact object whose `url` is either an absolute
 * href or a URL instance; the path is what decides whether a credential is
 * even relevant to this route.
 *
 * @param {any} request - Admission facts.
 * @returns {string} The path, or an empty string when unknown.
 */
function pathOf(request) {
  const raw = request?.url
  const href = typeof raw === 'string' ? raw : raw?.href ?? raw?.pathname ?? ''
  if (!href) return ''
  try {
    return new URL(href, 'http://dsh.invalid').pathname
  } catch {
    return ''
  }
}

/**
 * Create the push delivery service.
 *
 * @param {{ctx: any, config: any, logger?: any, overlay?: any, state?: any, activity?: any, agentPreset?: string, home?: any}} options - Service options.
 * @returns {{register: () => void, deliver: (payload: any, signal?: AbortSignal) => Promise<any>, dispose: () => void, path: string}} The service.
 */
export function createPushService(options) {
  const { ctx, config } = options
  const log = options.logger ?? ctx.logger
  const pushConfig = config.push ?? {}
  const path = pushConfig.path ?? DEFAULT_PUSH_PATH
  const staticToken = String(pushConfig.token ?? '')
  const target = pushConfig.target ?? {}
  const modelConfig = pushConfig.model ?? {}

  /**
   * Last known inbound token.
   *
   * The host asks credential providers synchronously, so the provider needs a
   * value it can read without awaiting. The authoritative check still happens
   * in the request handler, which reads the overlay per request; this cache
   * only decides whether the host admits the request at all.
   */
  let cachedToken = staticToken

  /** Timer that keeps the cached token in sync with the overlay. */
  let refreshTimer = null

  /**
   * Refresh the cached inbound token from the overlay.
   * @returns {Promise<void>} Resolves once the cache is up to date.
   */
  async function refreshToken() {
    try {
      const overlay = await options.overlay?.current?.()
      const token = String(overlay?.push?.token ?? '')
      cachedToken = token || staticToken
    } catch {
      /* keep the last known value */
    }
  }

  /**
   * Register the inbound credential with the host connection.
   *
   * DSH 0.2.3-alpha.1 routes default to `auth: 'required'`, so a machine
   * caller has to present a credential the host recognises. Registering a
   * provider makes the push token a first-class host credential instead of
   * leaving the route anonymous.
   *
   * @returns {boolean} Whether the provider was registered.
   */
  function registerAuthProvider() {
    // The credential registry and the connection service live in adjacent
    // scopes on DSH 0.2.3: the registry owns the providers, the connection
    // service owns `createPeer`. The plugin injects the registry, so both
    // are reachable from here — reading `connection.authentication` as a
    // property instead would go through cordis' Reflect proxy and fail with
    // "cannot get property ... without inject".
    const registry = ctx.get?.('connection.authentication')
    if (!registry || typeof registry.register !== 'function') return false
    const connection = ctx.get?.('connection')
    if (!connection || typeof connection.createPeer !== 'function') return false
    let peer
    try {
      peer = connection.createPeer({
        principal: { kind: PUSH_PRINCIPAL_KIND },
        interactions: 'none',
      })
    } catch (error) {
      log?.warn?.(
        `dsh-miloco-bridge: 创建推送 Peer 失败：${error instanceof Error ? error.message : error}`,
      )
      return false
    }
    let dispose
    try {
      dispose = registry.register({
        authenticate(request) {
          // Only the inbound push route may use this credential.
          if (pathOf(request) !== path) return undefined
          if (!tokenMatches(bearerOf(request), cachedToken)) return undefined
          return peer
        },
      })
    } catch (error) {
      log?.warn?.(
        `dsh-miloco-bridge: 注册推送凭据失败：${error instanceof Error ? error.message : error}`,
      )
      void peer.dispose()
      return false
    }
    ctx.effect(() => async () => {
      dispose()
      await peer.dispose()
    }, 'dsh-miloco-bridge: push auth provider')
    return true
  }

  /**
   * Directory a push-created session owns.
   * @returns {string} The effective household directory.
   */
  function homeDir() {
    return options.home?.dir || pushConfig.cwd || config.cwd
      || ctx.sandboxPolicy?.workspaceRoot || process.cwd()
  }

  /**
   * Read the effective target mode (overlay first, then static config).
   * @returns {Promise<'archive'|'session'>} The mode.
   */
  async function effectiveTargetMode() {
    if (options.overlay) {
      try {
        const value = normalizePushTargetMode((await options.overlay.current())?.push?.target?.mode)
        if (value) return value
      } catch { /* fall through to the static config */ }
    }
    return normalizePushTargetMode(config.push?.target?.mode) || 'archive'
  }

  /** @type {Map<string, {turn?: number, resolve: (v: any) => void, reject: (e: any) => void, timer: any, replies: string[]}>} */
  const waiters = new Map()
  /** @type {Map<string, {at: number, result: any}>} */
  const results = new Map()

  /**
   * Remember a run result for `get_trace` and idempotent retries.
   * @param {string} key - Idempotency key or run id.
   * @param {any} result - Delivery result.
   */
  function remember(key, result) {
    if (!key) return
    const now = Date.now()
    for (const [entryKey, entry] of results) {
      if (now - entry.at > RESULT_TTL_MS) results.delete(entryKey)
    }
    results.set(key, { at: now, result })
  }

  /**
   * Observe session events so a pending push can learn when its turn ended.
   * @param {any} session - The session that produced the event.
   * @param {any} event - The durable session event.
   */
  function onSessionEvent(session, event) {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (event?.type === 'turn/start') {
      const waiter = waiters.get(sessionId)
      if (waiter && waiter.turn === undefined) waiter.turn = event.data?.turn
      return
    }
    if (event?.type === 'assistant/message') {
      const waiter = waiters.get(sessionId)
      if (!waiter) return
      const text = (event.data?.message?.content ?? [])
        .filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('')
      if (text) waiter.replies.push(text)
      return
    }
    if (event?.type === 'turn/end') {
      const waiter = waiters.get(sessionId)
      if (!waiter) return
      const turn = event.data?.turn
      // Only the turn this push opened may settle it. A concurrent turn that
      // was already running when the push arrived must not resolve it early.
      if (waiter.turn === undefined || turn !== waiter.turn) return
      waiters.delete(sessionId)
      clearTimeout(waiter.timer)
      const rawReason = event.data?.reason
      const reason = typeof rawReason === 'string'
        ? rawReason
        : (rawReason?.kind ?? 'completed')
      waiter.resolve({
        status: reason === 'completed' ? 'ok' : 'error',
        reason,
        reply: waiter.replies.join('\n').trim(),
      })
    }
  }

  const disposeListener = ctx.on('session/event', onSessionEvent)

  /**
   * Resolve the effective target for one inbound push.
   *
   * @param {any} payload - The Miloco webhook payload.
   * @returns {Promise<{sessionId: string, source: string, explicit: boolean, mode: 'archive'|'session', model?: {provider: string, model: string, reasoningEffort?: string}}>} The target.
   */
  async function resolveTarget(payload) {
    const overlay = options.overlay ? await options.overlay.current() : null
    const overlayModel = overlay?.push?.model ?? {}
    const staticProvider = String(modelConfig.provider ?? '').trim()
    const staticModel = String(modelConfig.model ?? '').trim()
    const staticEffort = String(modelConfig.reasoningEffort ?? '').trim()

    // Model: configured means "pin this conversation to that model".
    // Empty means "do not call selectModel at all".
    const provider = (overlayModel.provider ?? '').trim() || staticProvider
    const model = (overlayModel.model ?? '').trim() || staticModel
    let modelSelection
    if (provider && model) {
      const reasoningEffort = (overlayModel.reasoningEffort ?? '').trim() || staticEffort
      modelSelection = reasoningEffort
        ? { provider, model, reasoningEffort }
        : { provider, model }
    }

    const mode = await effectiveTargetMode()
    if (mode === 'archive') {
      return {
        sessionId: ARCHIVE_SESSION_ID,
        source: 'archive',
        explicit: true,
        mode,
        ...(modelSelection ? { model: modelSelection } : {}),
      }
    }

    const overlaySession = (overlay?.push?.target?.sessionId ?? '').trim()
    const staticSession = String(target.sessionId ?? '').trim()
    const configuredSession = overlaySession || staticSession
    let sessionId = configuredSession
    let source = 'configured'
    if (!sessionId) {
      const lastSession = await options.activity?.last?.() ?? ''
      if (lastSession) {
        sessionId = lastSession
        source = 'last-miloco-session'
      } else {
        sessionId = sessionIdForMilocoKey(payload?.sessionKey ?? 'default')
        source = 'miloco-session-key'
      }
    }
    return {
      sessionId,
      source,
      explicit: Boolean(configuredSession),
      mode,
      ...(modelSelection ? { model: modelSelection } : {}),
    }
  }

  /**
   * Report whether a failure means "this session does not exist yet".
   * @param {unknown} error - The caught error.
   * @returns {boolean} Whether the session is missing.
   */
  function isMissingSession(error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (typeof code === 'string' && code.includes('not-found')) return true
    const message = error instanceof Error ? error.message : String(error ?? '')
    return /not[- ]found|no such session/i.test(message)
  }

  /**
   * Try to resolve a persisted/live session.
   * @param {string} sessionId - Session id.
   * @returns {Promise<boolean>} Whether it exists.
   */
  async function sessionExists(sessionId) {
    // `resolveAgent()` returns `{ error }` instead of throwing when the session
    // is missing. Ignoring the return value makes a push report "not found"
    // forever, so both shapes are checked here.
    let found
    try {
      found = await ctx.sessionController.resolveAgent(sessionId)
    } catch (error) {
      if (isMissingSession(error)) return false
      throw error
    }
    if (found === undefined || found === null) return false
    if (typeof found === 'object' && 'error' in found && found.error) {
      if (isMissingSession(found.error)) return false
      throw found.error
    }
    return true
  }

  /**
   * Attach one session to the household workspace.
   *
   * `sessionController.create({ cwd })` only sets the directory; workspace
   * membership is explicit. Without this the archive session shows up under
   * 「未分组」 in the native sidebar.
   *
   * @param {string} sessionId - Session to attach.
   * @returns {Promise<void>} Resolves once the attempt finished.
   */
  async function attachToHome(sessionId) {
    const workspaceId = String(options.home?.workspaceId ?? '')
    if (!workspaceId) return
    let registry
    try {
      registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    } catch { return }
    const workspace = registry?.get?.(workspaceId)
    if (!workspace || typeof workspace.attachSession !== 'function') return
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return
    try {
      await workspace.attachSession(sessionId)
    } catch (error) {
      log?.warn?.(
        `dsh-miloco-bridge: 把会话挂到家庭工作区失败：${error instanceof Error ? error.message : error}`,
      )
    }
  }

  /**
   * Create a session, falling back to "no preset" if the preset is unknown.
   * @param {string} sessionId - Desired id.
   * @returns {Promise<string>} The live session id.
   */
  async function createSession(sessionId) {
    const agentPreset = String(options.agentPreset ?? '').trim()
    const workspaceId = String(options.home?.workspaceId ?? '')
    // A workspace id both derives the cwd and attaches the session; a host
    // without one falls back to the plain household directory.
    const location = workspaceId ? { workspaceId } : { cwd: homeDir() }
    try {
      const created = await ctx.sessionController.create({
        sessionId,
        ...location,
        ...(agentPreset ? { agentPreset } : {}),
      })
      return created?.sessionId ?? sessionId
    } catch (error) {
      if (!agentPreset) throw error
      log?.warn?.(`dsh-miloco-bridge: 创建会话时挂载预设 ${agentPreset} 失败，退回无预设会话：${error instanceof Error ? error.message : error}`)
      const created = await ctx.sessionController.create({ sessionId, ...location })
      return created?.sessionId ?? sessionId
    }
  }

  /**
   * Ensure a target session exists and keep the conversation continuous.
   *
   * `create()` is for blank sessions: a persisted session that already ran a
   * turn is not reusable through it. Resolve first (which resumes the persisted
   * session) and create only when nothing is stored under that id.
   *
   * @param {{sessionId: string, explicit: boolean, mode: 'archive'|'session'}} resolvedTarget - Resolved target.
   * @param {any} payload - Inbound payload.
   * @returns {Promise<string>} The live session id.
   */
  async function ensureSession(resolvedTarget, payload) {
    const { sessionId, explicit, mode } = resolvedTarget
    if (await sessionExists(sessionId)) return sessionId

    if (mode === 'archive') {
      // The archive session is created once and then reused forever; only a
      // freshly created session is retitled (a manual rename must survive).
      const created = await createSession(sessionId)
      try {
        await ctx.sessionController.rename({ sessionId: created, title: ARCHIVE_SESSION_TITLE })
      } catch (error) {
        log?.warn?.(
          `dsh-miloco-bridge: 设置归档会话标题失败：${error instanceof Error ? error.message : error}`,
        )
      }
      return created
    }

    if (!explicit) {
      // A remembered "last session" may have been deleted. Fall back to the
      // stable id derived from Miloco's session key before creating a new one.
      const derived = sessionIdForMilocoKey(payload?.sessionKey ?? 'default')
      if (derived !== sessionId) {
        if (await sessionExists(derived)) return derived
        return createSession(derived)
      }
    }
    return createSession(sessionId)
  }

  /**
   * Read the effective perception minimum level (overlay first, static config
   * second). Changing it in the Web UI takes effect on the next push.
   * @returns {Promise<'all'|'low'|'medium'|'high'>} The level.
   */
  async function effectivePerceptionLevel() {
    let overlayLevel = ''
    try {
      const current = await options.overlay?.current?.()
      overlayLevel = current?.push?.perception?.minLevel ?? ''
    } catch { /* static fallback */ }
    return normalizePerceptionLevel(
      overlayLevel || config.push?.perception?.minLevel || 'all',
    )
  }

  /**
   * Read the host Session store, if the deployment provides one.
   * @returns {any} The session store, or undefined.
   */
  function sessionsService() {
    try {
      const found = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (found) return found
    } catch { /* fall through to the direct property */ }
    return ctx.sessions
  }

  /**
   * Deliver the push as a folded notification through the agent channel.
   *
   * `sessionController.prompt()` hard-codes `source.kind = 'user'`, so the
   * conversation can only render it as an ordinary user message. A folded
   * notification needs its own source: the client renders
   * `source.kind === 'miloco-push'` as a collapsed card whose summary stays
   * visible and whose body is only shown when the card is expanded.
   *
   * @param {string} sessionId - Target session.
   * @param {string} message - The push body.
   * @param {string} summary - One-line summary shown while folded.
   * @returns {Promise<boolean>} Whether the folded channel handled the push.
   */
  async function deliverFolded(sessionId, message, summary) {
    let agent = null
    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (resolved && typeof resolved === 'object' && resolved.agent) {
        agent = resolved.agent
      } else if (resolved && typeof resolved === 'object' && resolved.error) {
        log?.warn?.(
          `dsh-miloco-bridge: 折叠投递无法解析 Agent，回退到普通提示：${resolved.error instanceof Error ? resolved.error.message : String(resolved.error)}`,
        )
        return false
      }
    } catch (error) {
      log?.warn?.(
        `dsh-miloco-bridge: 折叠投递解析 Agent 失败，回退到普通提示：${error instanceof Error ? error.message : error}`,
      )
      return false
    }
    if (!agent || typeof agent.followup !== 'function') return false

    const notice = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: { kind: PUSH_SOURCE_KIND, form: 'notice', summary },
    }
    try {
      agent.followup(notice)
    } catch (error) {
      log?.warn?.(
        `dsh-miloco-bridge: 折叠投递写入 Agent 失败，回退到普通提示：${error instanceof Error ? error.message : error}`,
      )
      return false
    }

    const sessions = sessionsService()
    if (sessions && typeof sessions.flush === 'function' && agent.session) {
      try {
        await sessions.flush(agent.session)
      } catch (error) {
        log?.warn?.(
          `dsh-miloco-bridge: 折叠投递落盘失败：${error instanceof Error ? error.message : error}`,
        )
      }
    }
    return true
  }

  /**
   * Deliver one Miloco push into DSH.
   *
   * @param {any} payload - `{message, sessionKey, lane, traceId, timeoutMs, idempotencyKey, urgency}`.
   * @param {AbortSignal} [signal] - Cancellation signal.
   * @returns {Promise<any>} Delivery outcome.
   */
  async function deliver(payload, signal) {
    const message = typeof payload?.message === 'string' ? payload.message : ''
    if (!message.trim()) throw new Error('payload.message 为空')

    const idempotencyKey = String(payload?.idempotencyKey ?? payload?.traceId ?? '')
    if (idempotencyKey) {
      const cached = results.get(idempotencyKey)
      if (cached && Date.now() - cached.at <= RESULT_TTL_MS) {
        return { ...cached.result, idempotent: true }
      }
    }

    // Perception filtering happens before target resolution: a filtered event
    // does not resume/create a session and never becomes an LLM turn.
    const urgency = parseUrgency(payload)
    const minLevel = await effectivePerceptionLevel()
    if (!perceptionAllowed(urgency, minLevel)) {
      const filtered = {
        runId: null,
        status: 'filtered',
        sessionId: '',
        source: 'perception-filter',
        filtered: true,
        urgency,
        minLevel,
        reason: 'below-perception-level',
      }
      log?.info?.(
        `dsh-miloco-bridge: perception event filtered urgency=${urgency || 'unknown'} min=${minLevel}`,
      )
      remember(idempotencyKey, filtered)
      return filtered
    }

    const resolved = await resolveTarget(payload)
    // The household workspace must exist before a session claims it as cwd.
    if (typeof options.home?.ensure === 'function') {
      try {
        await options.home.ensure()
      } catch (error) {
        log?.warn?.(
          `dsh-miloco-bridge: 准备家庭助手目录失败：${error instanceof Error ? error.message : error}`,
        )
      }
    }
    const sessionId = await ensureSession(resolved, payload)
    if (resolved.mode === 'archive') await attachToHome(sessionId)
    await options.activity?.note?.(sessionId)

    const summary = pushDisplayTitle(payload, message)
    const runId = randomUUID()
    const requestId = randomUUID()

    /**
     * Append one delivery record to the shared push log.
     * @param {string} status - Delivery status.
     * @returns {Promise<void>} Resolves once the record is attempted.
     */
    async function recordPush(status) {
      if (!options.state) return
      try {
        await notePush(options.state, {
          at: Date.now(),
          title: summary,
          summary,
          sessionId,
          status,
          runId,
        })
      } catch (error) {
        log?.warn?.(`dsh-miloco-bridge: 写入推送记录失败：${error instanceof Error ? error.message : error}`)
      }
    }

    if (resolved.model) {
      await ctx.sessionController.selectModel({
        sessionId,
        provider: resolved.model.provider,
        model: resolved.model.model,
        ...(resolved.model.reasoningEffort ? { reasoningEffort: resolved.model.reasoningEffort } : {}),
      })
    }

    const waitMs = Number.isFinite(payload?.timeoutMs) && payload.timeoutMs > 0
      ? Math.min(payload.timeoutMs, 600_000)
      : 120_000

    const waitForTurn = pushConfig.waitForResult !== false
    // Only one delivery may own the session's waiter. A second overlapping
    // push is delivered but not tracked: it must not unregister or resolve the
    // waiter the first push opened.
    const queued = waitForTurn && waiters.has(sessionId)
    /** @type {PromiseWithResolvers<any> | null} */
    let completion = null
    if (waitForTurn && !queued) {
      completion = Promise.withResolvers()
      const timer = setTimeout(() => {
        waiters.delete(sessionId)
        completion?.resolve({ status: 'timeout', reason: 'timeout', reply: '' })
      }, waitMs + 5_000)
      if (typeof timer.unref === 'function') timer.unref()
      waiters.set(sessionId, { resolve: completion.resolve, reject: completion.reject, timer, replies: [], turn: undefined })
    }

    // 折叠投递优先：走 Agent 通道，消息带 `miloco-push` source，客户端折叠展示。
    // 拿不到 Agent 时回退到普通的 `prompt` 路径（旧行为保持可用）。
    let folded = false
    try {
      folded = await deliverFolded(sessionId, message, summary)
    } catch (error) {
      if (completion) {
        const waiter = waiters.get(sessionId)
        if (waiter) {
          clearTimeout(waiter.timer)
          waiters.delete(sessionId)
        }
      }
      await recordPush('error')
      throw error
    }

    if (!folded) {
      try {
        await ctx.sessionController.prompt({
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: message }],
        }, signal ?? new AbortController().signal)
      } catch (error) {
        if (completion) {
          const waiter = waiters.get(sessionId)
          if (waiter) {
            clearTimeout(waiter.timer)
            waiters.delete(sessionId)
          }
        }
        await recordPush('error')
        throw error
      }
    }

    if (!completion) {
      await recordPush('ok')
      const result = {
        runId,
        status: 'ok',
        sessionId,
        source: resolved.source,
        folded,
        async: true,
        ...(queued ? { queued: true } : {}),
      }
      remember(idempotencyKey, result)
      return result
    }

    const settled = await completion.promise
    await recordPush(settled.status)
    const result = {
      runId,
      status: settled.status,
      sessionId,
      source: resolved.source,
      folded,
      ...(settled.reply ? { reply: settled.reply } : {}),
      ...(settled.status === 'error' ? { error: settled.reason ?? 'turn failed' } : {}),
    }
    remember(idempotencyKey, result)
    remember(runId, result)
    return result
  }

  /**
   * Read the effective inbound token (overlay first, then static config).
   * @returns {Promise<string>} The bearer token, or an empty string.
   */
  async function effectiveToken() {
    try {
      const overlay = await options.overlay?.current?.()
      const token = String(overlay?.push?.token ?? '')
      if (token) return token
    } catch { /* fall through to static config */ }
    return staticToken
  }

  /**
   * Handle one inbound webhook request.
   * @param {import('node:http').IncomingMessage} req - The request.
   * @param {import('node:http').ServerResponse} res - The response.
   */
  async function handleWebhook(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { code: 1, message: 'method not allowed', data: null })
      return
    }
    if (!pushConfig.enabled) {
      sendJson(res, 503, { code: 1, message: 'push.enabled=false，拒绝所有入站推送', data: null })
      return
    }
    const expectedToken = await effectiveToken()
    if (!expectedToken) {
      sendJson(res, 503, { code: 1, message: '推送令牌未配置，拒绝所有入站推送', data: null })
      return
    }
    if (!tokenMatches(bearerOf(req), expectedToken)) {
      sendJson(res, 401, { code: 1, message: 'unauthorized', data: null })
      return
    }

    let body
    try {
      const text = await readBody(req, 2 * 1024 * 1024)
      body = text ? JSON.parse(text) : {}
    } catch (error) {
      sendJson(res, 400, { code: 1, message: `invalid JSON body: ${error instanceof Error ? error.message : error}`, data: null })
      return
    }

    const action = body?.action ?? 'agent'
    if (action === 'get_trace') {
      const runId = String(body?.payload?.runId ?? body?.payload?.run_id ?? '')
      const cached = runId ? results.get(runId) : undefined
      sendJson(res, 200, {
        code: 0,
        message: '',
        data: cached ? { status: 'done', ...cached.result } : { status: 'unknown' },
      })
      return
    }
    if (action === 'reset_sessions') {
      const keys = Array.isArray(body?.payload?.sessionKeys) ? body.payload.sessionKeys : []
      const sessionIds = keys.map(key => sessionIdForMilocoKey(key))
      await options.activity?.clear?.(sessionIds)
      sendJson(res, 200, { code: 0, message: '', data: { cleared: sessionIds } })
      return
    }
    if (action !== 'agent') {
      sendJson(res, 400, { code: 1, message: `unsupported action: ${action}`, data: null })
      return
    }

    try {
      const result = await deliver(body?.payload ?? {})
      sendJson(res, 200, { code: 0, message: '', data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const shape = error && typeof error === 'object'
        ? ` [${error.name ?? 'Error'}${error.code ? `/${error.code}` : ''}]`
        : ''
      log?.warn?.(`dsh-miloco-bridge: push delivery failed: ${message}${shape}`)
      sendJson(res, 200, { code: 1, message: `${message}${shape}`, data: { status: 'error' } })
    }
  }

  /**
   * Register the inbound route on the host web server.
   * @returns {void}
   */
  function register() {
    // The host admits the request only when the push token is presented as a
    // host credential; the handler re-checks it against the live overlay.
    const credentialed = registerAuthProvider()
    if (!credentialed) {
      // Without the credential the host would refuse the machine caller
      // before the plugin's own bearer check could run, so the route must not
      // claim to require a credential it cannot verify.
      log?.warn?.(
        'dsh-miloco-bridge: 无法注册推送凭据，入站路由退回匿名校验；'
        + '请确认宿主版本支持 connection.authentication 服务。',
      )
    }
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      // DSH 0.2.3-alpha.1 起 WebServer 路由默认 `auth: 'required'`，
      // 机器调用方必须出示宿主认可的凭据。注册了 provider 就走 required；
      // 没注册时退回匿名，插件自己的 bearer 校验仍然生效。
      auth: credentialed ? 'required' : 'anonymous',
      handler: (req, res) => {
        void handleWebhook(req, res)
      },
    })
    ctx.effect(() => dispose, 'dsh-miloco-bridge: push webhook route')
    void refreshToken()
    refreshTimer = setInterval(() => {
      void refreshToken()
    }, 5_000)
    refreshTimer.unref?.()
    ctx.effect(() => () => clearInterval(refreshTimer), 'dsh-miloco-bridge: push token refresh')
    // Migrate an archive session created before workspace attachment existed.
    void (async () => {
      try {
        await options.home?.ensure?.()
        if (await sessionExists(ARCHIVE_SESSION_ID)) await attachToHome(ARCHIVE_SESSION_ID)
      } catch (error) {
        log?.warn?.(
          `dsh-miloco-bridge: 归档会话挂载检查失败：${error instanceof Error ? error.message : error}`,
        )
      }
    })()
    log?.info?.(`dsh-miloco-bridge: push webhook listening on ${path}`)
  }

  /**
   * Release every waiter and the event listener.
   */
  function dispose() {
    for (const waiter of waiters.values()) clearTimeout(waiter.timer)
    waiters.clear()
    results.clear()
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
    disposeListener()
  }

  return { register, deliver, dispose, path, handleWebhook, refreshToken }
}
