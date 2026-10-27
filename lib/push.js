/**
 * Miloco -> DSH push delivery.
 *
 * Miloco is the active side of the household brain: it watches cameras,
 * evaluates rules and expires tasks, then asks an Agent to react. This module
 * is the receiving end of that loop.
 *
 * Delivery target rules (exactly the owner's semantics):
 *
 * 1. `target.sessionId` configured (runtime overlay, then static config)
 *    -> deliver to that conversation.
 * 2. Nothing configured -> deliver to **the session that last touched a
 *    Miloco tool** (state file). If there is none, derive a stable session id
 *    from Miloco's `sessionKey`.
 * 3. Model not configured -> do not touch the session's model at all; it keeps
 *    following whatever model that conversation already selected.
 * 4. Model configured (provider + model) -> select that model for the target
 *    session before prompting.
 *
 * The inbound route authenticates with a bearer token. The effective token is
 * `overlay.push.token` or `push.token` from static config; when both are empty
 * every inbound request is refused (fail closed).
 *
 * @module dsh-miloco-bridge/push
 */

import { randomUUID } from 'node:crypto'
import {
  normalizePerceptionLevel,
  parseUrgency,
  perceptionAllowed,
} from './perception.js'

/** Default inbound route path. */
export const DEFAULT_PUSH_PATH = '/miloco/webhook'

/** How long a delivered idempotency key / run id is remembered. */
const RESULT_TTL_MS = 10 * 60_000

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
 * Create the push delivery service.
 *
 * @param {{ctx: any, config: any, logger?: any, overlay?: any, activity?: any, agentPreset?: string}} options - Service options.
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
  const cwd = pushConfig.cwd || config.cwd || ctx.sandboxPolicy?.workspaceRoot || process.cwd()

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
   * @returns {Promise<{sessionId: string, source: string, explicit: boolean, model?: {provider: string, model: string, reasoningEffort?: string}}>} The target.
   */
  async function resolveTarget(payload) {
    const overlay = options.overlay ? await options.overlay.current() : null
    const overlaySession = (overlay?.push?.target?.sessionId ?? '').trim()
    const overlayModel = overlay?.push?.model ?? {}

    const staticSession = String(target.sessionId ?? '').trim()
    const staticProvider = String(modelConfig.provider ?? '').trim()
    const staticModel = String(modelConfig.model ?? '').trim()
    const staticEffort = String(modelConfig.reasoningEffort ?? '').trim()

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

    // Model: configured means "pin this conversation to that model".
    // Empty means "do not call selectModel at all".
    const provider = (overlayModel.provider ?? '').trim() || staticProvider
    const model = (overlayModel.model ?? '').trim() || staticModel
    if (provider && model) {
      const reasoningEffort = (overlayModel.reasoningEffort ?? '').trim() || staticEffort
      return {
        sessionId,
        source,
        explicit: Boolean(configuredSession),
        model: reasoningEffort ? { provider, model, reasoningEffort } : { provider, model },
      }
    }
    return { sessionId, source, explicit: Boolean(configuredSession) }
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
   * Create a session, falling back to "no preset" if the preset is unknown.
   * @param {string} sessionId - Desired id.
   * @returns {Promise<string>} The live session id.
   */
  async function createSession(sessionId) {
    const agentPreset = String(options.agentPreset ?? '').trim()
    try {
      const created = await ctx.sessionController.create({
        sessionId,
        cwd,
        ...(agentPreset ? { agentPreset } : {}),
      })
      return created?.sessionId ?? sessionId
    } catch (error) {
      if (!agentPreset) throw error
      log?.warn?.(`dsh-miloco-bridge: 创建会话时挂载预设 ${agentPreset} 失败，退回无预设会话：${error instanceof Error ? error.message : error}`)
      const created = await ctx.sessionController.create({ sessionId, cwd })
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
   * @param {{sessionId: string, explicit: boolean}} resolvedTarget - Resolved target.
   * @param {any} payload - Inbound payload.
   * @returns {Promise<string>} The live session id.
   */
  async function ensureSession(resolvedTarget, payload) {
    const { sessionId, explicit } = resolvedTarget
    if (await sessionExists(sessionId)) return sessionId

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
    const sessionId = await ensureSession(resolved, payload)
    await options.activity?.note?.(sessionId)

    if (resolved.model) {
      await ctx.sessionController.selectModel({
        sessionId,
        provider: resolved.model.provider,
        model: resolved.model.model,
        ...(resolved.model.reasoningEffort ? { reasoningEffort: resolved.model.reasoningEffort } : {}),
      })
    }

    const runId = randomUUID()
    const requestId = randomUUID()
    const waitMs = Number.isFinite(payload?.timeoutMs) && payload.timeoutMs > 0
      ? Math.min(payload.timeoutMs, 600_000)
      : 120_000

    const waitForTurn = pushConfig.waitForResult !== false
    /** @type {PromiseWithResolvers<any> | null} */
    let completion = null
    if (waitForTurn) {
      completion = Promise.withResolvers()
      const timer = setTimeout(() => {
        waiters.delete(sessionId)
        completion?.resolve({ status: 'timeout', reason: 'timeout', reply: '' })
      }, waitMs + 5_000)
      if (typeof timer.unref === 'function') timer.unref()
      waiters.set(sessionId, { resolve: completion.resolve, reject: completion.reject, timer, replies: [], turn: undefined })
    }

    try {
      await ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
      }, signal ?? new AbortController().signal)
    } catch (error) {
      const waiter = waiters.get(sessionId)
      if (waiter) {
        clearTimeout(waiter.timer)
        waiters.delete(sessionId)
      }
      throw error
    }

    if (!completion) {
      const result = { runId, status: 'ok', sessionId, source: resolved.source, async: true }
      remember(idempotencyKey, result)
      return result
    }

    const settled = await completion.promise
    const result = {
      runId,
      status: settled.status,
      sessionId,
      source: resolved.source,
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
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler: (req, res) => {
        void handleWebhook(req, res)
      },
    })
    ctx.effect(() => dispose, 'dsh-miloco-bridge: push webhook route')
    log?.info?.(`dsh-miloco-bridge: push webhook listening on ${path}`)
  }

  /**
   * Release every waiter and the event listener.
   */
  function dispose() {
    for (const waiter of waiters.values()) clearTimeout(waiter.timer)
    waiters.clear()
    results.clear()
    disposeListener()
  }

  return { register, deliver, dispose, path, handleWebhook }
}
