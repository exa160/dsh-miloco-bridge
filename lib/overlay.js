/**
 * Runtime overlay file.
 *
 * Static plugin configuration decides defaults. The overlay file holds the
 * choices the owner changes at runtime from the Web settings tab:
 *
 * - how to reach Miloco (`connection.baseUrl` / `connection.token`);
 * - where an inbound push lands (`push.target.sessionId`);
 * - whether a specific model handles the pushed turn (`push.model`);
 * - the bearer token Miloco must present (`push.token`).
 *
 * The file is re-read (with a short cache) so connection and target changes
 * apply without restarting DSH. It is written atomically with mode `0600`
 * because it may contain a token.
 *
 * Shape (`~/.dsh/miloco-plugin.json`):
 *
 *     {
 *       "connection": { "baseUrl": "http://127.0.0.1:1810", "token": "..." },
 *       "push": {
 *         "token": "...",
 *         "target": { "sessionId": "" },
 *         "model":  { "provider": "", "model": "", "reasoningEffort": "" }
 *       }
 *     }
 *
 * @module dsh-miloco-bridge/overlay
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expandHome, resolveDshHome } from './paths.js'
import { normalizePerceptionLevel } from './perception.js'

/** Default overlay file location. */
export const DEFAULT_OVERLAY_FILE = join(resolveDshHome(), 'miloco-plugin.json')

/**
 * Normalise an arbitrary overlay payload.
 * @param {any} raw - Parsed overlay content.
 * @returns {{connection: {baseUrl: string, token: string}, push: {token: string, target: {sessionId: string}, model: {provider: string, model: string, reasoningEffort: string}}}} The normalised overlay.
 */
export function normalizeOverlay(raw) {
  const root = raw && typeof raw === 'object' ? raw : {}
  const connection = root.connection && typeof root.connection === 'object' ? root.connection : {}
  const push = root.push && typeof root.push === 'object' ? root.push : {}
  const target = push.target && typeof push.target === 'object' ? push.target : {}
  const model = push.model && typeof push.model === 'object' ? push.model : {}
  const perception = push.perception && typeof push.perception === 'object' ? push.perception : {}
  return {
    connection: {
      baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl.trim() : '',
      token: typeof connection.token === 'string' ? connection.token : '',
    },
    push: {
      token: typeof push.token === 'string' ? push.token : '',
      target: {
        // 空 = 用「上一次触发 miloco 的会话」
        sessionId: typeof target.sessionId === 'string' ? target.sessionId.trim() : '',
      },
      model: {
        // 空 = 跟随该会话自己选的模型
        provider: typeof model.provider === 'string' ? model.provider.trim() : '',
        model: typeof model.model === 'string' ? model.model.trim() : '',
        reasoningEffort: typeof model.reasoningEffort === 'string' ? model.reasoningEffort.trim() : '',
      },
      perception: {
        // 低于该等级的感知建议不投递到 DSH
        minLevel: normalizePerceptionLevel(perception.minLevel),
      },
    },
  }
}

/**
 * Create the overlay reader/writer.
 *
 * @param {{file?: string, ttlMs?: number, logger?: any}} [options] - Overlay options.
 * @returns {{file: string, read: () => Promise<any>, current: () => Promise<any>, write: (value: any) => Promise<void>}} The overlay.
 */
export function createOverlay(options = {}) {
  const file = expandHome(options.file || DEFAULT_OVERLAY_FILE)
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : 1_000
  const logger = options.logger
  /** @type {{at: number, value: any}} */
  let cache = { at: 0, value: undefined }

  /**
   * Read the overlay file from disk.
   * @returns {Promise<any>} The parsed payload, or an empty object when missing.
   */
  async function read() {
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`dsh-miloco-bridge: 读取覆盖配置 ${file} 失败：${error instanceof Error ? error.message : error}`)
      }
      return {}
    }
  }

  /**
   * Read the overlay with a short cache.
   * @returns {Promise<any>} The normalised overlay.
   */
  async function current() {
    const now = Date.now()
    if (cache.value !== undefined && now - cache.at < ttlMs) return cache.value
    const value = normalizeOverlay(await read())
    cache = { at: now, value }
    return value
  }

  /**
   * Write the overlay file atomically.
   * @param {any} value - Payload to store.
   * @returns {Promise<void>} Resolves once the file is written.
   */
  async function write(value) {
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(normalizeOverlay(value), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600).catch(() => {})
    cache = { at: 0, value: undefined }
  }

  return { file, read, current, write }
}
