/**
 * Test helpers: a fake Miloco backend and a fake raw HTTP request.
 */

import { createServer } from 'node:http'
import { Readable } from 'node:stream'

/**
 * Start a fake Miloco backend.
 * @param {Record<string, any>} [overrides] - Endpoint overrides keyed by path.
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>, requests: any[]}>} The server.
 */
export async function createFakeMiloco(overrides = {}) {
  const requests = []
  const defaults = {
    '/api/admin/status': { code: 0, data: { miot: { ok: true }, perception: { ok: true }, rule_engine: { ok: true }, sqlite: { ok: true } } },
    '/api/miot/user_info': { code: 0, data: { nickname: 'TestUser', uid: 'uid-1' } },
    '/api/miot/login_status': { code: 0, data: { logged_in: true } },
    '/api/miot/device_list': { code: 0, data: [{ did: 'd1' }, { did: 'd2' }] },
    '/api/miot/camera_list': { code: 0, data: [{ did: 'cam1' }] },
    '/api/rules': { code: 0, data: [{ id: 'r1' }] },
    '/api/tasks': { code: 0, data: [] },
    '/api/perception/engine/status': { code: 0, data: { running: true, active_sources: ['cam1'], today_inference_count: 7 } },
    '/api/admin/token-usage': { code: 0, data: { events: [{ input_tokens: 100, output_tokens: 20 }, { input_tokens: 20, output_tokens: 10 }], total: 2 } },
    '/api/home-profile/rendered': { code: 0, data: { markdown: '# 家庭档案' } },
    '/api/home-profile/entries': { code: 0, data: { entries: [] } },
  }
  const routes = { ...defaults, ...overrides }

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) })
    const payload = routes[url.pathname]
    if (payload === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 404, message: 'not found' }))
      return
    }
    const body = typeof payload === 'function' ? payload(req, url) : payload
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * Invoke a raw route handler with a JSON body.
 * @param {(req: any, res: any) => Promise<void>|void} handler - Route handler.
 * @param {{method?: string, headers?: Record<string, string>, body?: any}} [options] - Request options.
 * @returns {Promise<{status: number, body: any, headers: Record<string, string>}>} The response.
 */
export async function invoke(handler, options = {}) {
  const text = options.body === undefined ? '' : JSON.stringify(options.body)
  const req = Readable.from(text ? [Buffer.from(text)] : [])
  req.method = options.method ?? 'POST'
  req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json', ...(options.headers ?? {}) }
  const result = { status: 0, body: undefined, headers: {} }
  const res = {
    headersSent: false,
    writeHead(status, headers) {
      result.status = status
      result.headers = headers ?? {}
      this.headersSent = true
      return this
    },
    end(chunk) {
      if (typeof chunk === 'string') {
        try {
          result.body = JSON.parse(chunk)
        } catch {
          result.body = chunk
        }
      }
      return this
    },
  }
  await handler(req, res)
  return result
}

/**
 * Build a fake session controller.
 * @param {{existing?: string[], waitForResult?: boolean}} [options] - Options.
 * @returns {any} The fake controller and call log.
 */
export function createFakeSessionController(options = {}) {
  const existing = new Set(options.existing ?? [])
  const calls = []
  const listeners = new Set()
  let promptBehavior = null

  const controller = {
    calls,
    existing,
    onPrompt(behavior) {
      promptBehavior = behavior
    },
    emit(session, event) {
      for (const listener of listeners) listener(session, event)
    },
    async resolveAgent(sessionId) {
      calls.push(['resolveAgent', sessionId])
      if (existing.has(sessionId)) return { agent: { session: { header: { id: sessionId } } } }
      return { error: Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' }) }
    },
    async create(request) {
      calls.push(['create', request.sessionId, request.agentPreset])
      existing.add(request.sessionId)
      return { sessionId: request.sessionId }
    },
    async selectModel(request) {
      calls.push(['selectModel', request.sessionId, request.provider, request.model, request.reasoningEffort])
      return { selected: request }
    },
    async prompt(request) {
      calls.push(['prompt', request.sessionId, request.content?.[0]?.text])
      if (promptBehavior) await promptBehavior(request, controller)
      return { runId: 'run-1' }
    },
  }

  return {
    controller,
    calls,
    on(_name, listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
