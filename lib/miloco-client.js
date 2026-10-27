/**
 * Miloco backend HTTP client.
 *
 * Miloco's FastAPI backend answers under `/api/*` with the envelope
 * `{ code, message, data }`. This module is a dependency-free client that
 * resolves an endpoint, performs the request, unwraps the envelope, and turns
 * every failure into one {@link MilocoError} shape so tools can report a
 * readable reason to the model.
 *
 * Connection precedence (highest first):
 *   1. runtime overlay (`~/.dsh/miloco-plugin.json` → `connection`)
 *   2. static plugin config (`baseUrl` / `token` in cordis.patch.yml)
 *   3. `$MILOCO_HOME/config.json` (`server.url` / `server.token`)
 *   4. `http://127.0.0.1:1810`
 *
 * The overlay layer is what makes "connect an existing Miloco" take effect
 * immediately: the settings tab writes it, and both plugin halves read it on
 * every request without a DSH restart.
 *
 * @module dsh-miloco-bridge/miloco-client
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expandHome } from './paths.js'

/** Error raised for every Miloco backend failure (transport, HTTP, or business code). */
export class MilocoError extends Error {
  /**
   * @param {string} message - Human-readable failure reason.
   * @param {{code?: number|string, status?: number, path?: string}} [details] - Failure metadata.
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'MilocoError'
    this.code = details.code
    this.status = details.status
    this.path = details.path
  }
}

/**
 * Resolve the Miloco home directory.
 * @param {string} [override] - Explicit home; empty falls back to `MILOCO_HOME` or `~/.miloco`.
 * @returns {string} Absolute home directory.
 */
export function resolveMilocoHome(override) {
  const raw = (override ?? process.env.MILOCO_HOME ?? '').trim()
  if (raw) return expandHome(raw)
  return expandHome('~/.miloco')
}

/**
 * Read `config.json` from the Miloco home directory.
 * @param {string} home - Miloco home directory.
 * @returns {Promise<Record<string, any>>} Parsed config, or an empty object when absent/corrupt.
 */
export async function readMilocoConfig(home) {
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Create a Miloco backend client.
 *
 * @param {{baseUrl?: string, token?: string, timeoutMs?: number, home?: string, overlay?: any}} options - Client options.
 * @returns {{
 *   request: (method: string, path: string, opts?: {query?: Record<string, any>, body?: any, signal?: AbortSignal}) => Promise<any>,
 *   get: (path: string, opts?: {query?: Record<string, any>, signal?: AbortSignal}) => Promise<any>,
 *   post: (path: string, body?: any, opts?: {query?: Record<string, any>, signal?: AbortSignal}) => Promise<any>,
 *   put: (path: string, body?: any, opts?: {query?: Record<string, any>, signal?: AbortSignal}) => Promise<any>,
 *   delete: (path: string, opts?: {query?: Record<string, any>, signal?: AbortSignal}) => Promise<any>,
 *   postMultipart: (path: string, opts?: any) => Promise<any>,
 *   endpoint: () => Promise<{baseUrl: string, token: string, home: string, source: string}>,
 * }} The client.
 */
export function createMilocoClient(options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30_000
  const configuredHome = resolveMilocoHome(options.home)

  /**
   * Resolve the effective endpoint and token.
   * @returns {Promise<{baseUrl: string, token: string, home: string, source: string}>} Effective connection settings.
   */
  async function endpoint() {
    const home = configuredHome
    let overlay = null
    try {
      overlay = await options.overlay?.current?.()
    } catch {
      overlay = null
    }
    const connection = overlay?.connection ?? {}
    const fileConfig = await readMilocoConfig(home)
    const server = fileConfig.server ?? {}

    const candidates = [
      [connection.baseUrl, connection.token, 'overlay'],
      [options.baseUrl, options.token, 'config'],
      [server.url, server.token, 'miloco-config'],
      ['http://127.0.0.1:1810', '', 'default'],
    ]
    for (const [url, token, source] of candidates) {
      const baseUrl = String(url ?? '').trim()
      if (!baseUrl) continue
      return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        token: String(token ?? '').trim(),
        home,
        source,
      }
    }
    return { baseUrl: 'http://127.0.0.1:1810', token: '', home, source: 'default' }
  }

  /**
   * Perform one backend request and unwrap the response envelope.
   * @param {string} method - HTTP method.
   * @param {string} path - API path starting with `/api`.
   * @param {{query?: Record<string, any>, body?: any, signal?: AbortSignal}} [opts] - Request options.
   * @returns {Promise<any>} The envelope's `data` field.
   */
  async function request(method, path, opts = {}) {
    const { baseUrl, token } = await endpoint()
    const url = new URL(path.startsWith('/') ? path : `/${path}`, baseUrl)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
    const headers = { accept: 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    let body
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }

    const timeout = AbortSignal.timeout(timeoutMs)
    const signals = [timeout]
    if (opts.signal) signals.push(opts.signal)
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

    let response
    try {
      response = await fetch(url, { method, headers, body, signal })
    } catch (error) {
      if (opts.signal?.aborted) throw error
      throw new MilocoError(
        `无法连接 Miloco 后端 ${baseUrl}：${error instanceof Error ? error.message : String(error)}。`
        + '请确认 Miloco 已启动，或到「设置 → 插件 → Miloco」部署/连接一个实例。',
        { path },
      )
    }

    const text = await response.text()
    if (!response.ok) {
      throw new MilocoError(
        `Miloco 后端返回 HTTP ${response.status}：${text.slice(0, 300) || '(空响应)'}`,
        { status: response.status, path },
      )
    }
    let payload
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new MilocoError(`Miloco 后端返回了非 JSON 响应：${text.slice(0, 200)}`, { path })
    }
    if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 0) {
      throw new MilocoError(
        `Miloco 后端错误 code=${payload.code}：${payload.message ?? '未知错误'}`,
        { code: payload.code, path },
      )
    }
    if (payload && typeof payload === 'object' && 'data' in payload) return payload.data
    return payload
  }

  return {
    request,
    endpoint,
    get: (path, opts = {}) => request('GET', path, opts),
    post: (path, body, opts = {}) => request('POST', path, { ...opts, body }),
    put: (path, body, opts = {}) => request('PUT', path, { ...opts, body }),
    patch: (path, body, opts = {}) => request('PATCH', path, { ...opts, body }),
    delete: (path, opts = {}) => request('DELETE', path, opts),
    /**
     * Upload local files as `multipart/form-data`.
     * @param {string} path - API path.
     * @param {{files?: {field: string, path: string, filename?: string}[], fields?: Record<string, string>, signal?: AbortSignal}} opts - Upload options.
     * @returns {Promise<any>} The envelope's `data` field.
     */
    async postMultipart(path, opts = {}) {
      const { baseUrl, token } = await endpoint()
      const url = new URL(path.startsWith('/') ? path : `/${path}`, baseUrl)
      const form = new FormData()
      for (const [key, value] of Object.entries(opts.fields ?? {})) {
        if (value !== undefined && value !== null) form.append(key, String(value))
      }
      for (const file of opts.files ?? []) {
        const bytes = await readFile(file.path)
        form.append(file.field, new Blob([bytes]), file.filename ?? file.path.split('/').pop())
      }
      const headers = { accept: 'application/json' }
      if (token) headers.authorization = `Bearer ${token}`
      const response = await fetch(url, { method: 'POST', headers, body: form, signal: opts.signal })
      const text = await response.text()
      if (!response.ok) {
        throw new MilocoError(`Miloco 后端返回 HTTP ${response.status}：${text.slice(0, 300) || '(空响应)'}`, { status: response.status, path })
      }
      let payload
      try {
        payload = text ? JSON.parse(text) : {}
      } catch {
        throw new MilocoError(`Miloco 后端返回了非 JSON 响应：${text.slice(0, 200)}`, { path })
      }
      if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 0) {
        throw new MilocoError(`Miloco 后端错误 code=${payload.code}：${payload.message ?? '未知错误'}`, { code: payload.code, path })
      }
      if (payload && typeof payload === 'object' && 'data' in payload) return payload.data
      return payload
    },
  }
}
