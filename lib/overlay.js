/**
 * Runtime overlay file.
 *
 * Static plugin configuration decides defaults. The overlay file holds the
 * choices the owner changes at runtime from the Web settings tab:
 *
 * - how to reach Miloco (`connection.baseUrl` / `connection.token`);
 * - which household workspace directory the tools work in (`home.dir`);
 * - whether the household workspace is registered and pinned (`workspace.enabled`);
 * - where an inbound push lands (`push.target.mode` / `push.target.sessionId`);
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
 *       "home": { "dir": "~/miloco-home" },
 *       "workspace": { "enabled": true },
 *       "push": {
 *         "token": "...",
 *         "target": { "mode": "archive", "sessionId": "" },
 *         "model":  { "provider": "", "model": "", "reasoningEffort": "" }
 *       }
 *     }
 *
 * `write()` merges section by section with what is already on disk, so a
 * partial write (for example only `home.dir`) never drops the other
 * sections. An explicit empty string still clears a field.
 *
 * @module dsh-miloco-bridge/overlay
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expandHome, resolveDshHome } from './paths.js'
import { normalizePerceptionLevel } from './perception.js'

/** Default overlay file location. */
export const DEFAULT_OVERLAY_FILE = join(resolveDshHome(), 'miloco-plugin.json')

/** Supported push target modes: a dedicated archive session or a chosen session. */
export const PUSH_TARGET_MODES = ['archive', 'session']

/**
 * Normalise a push target mode.
 * @param {unknown} value - Raw value.
 * @returns {'archive'|'session'|''} A supported mode, or '' when unset/unknown.
 */
export function normalizePushTargetMode(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return PUSH_TARGET_MODES.includes(text) ? text : ''
}

/**
 * Normalise an arbitrary overlay payload.
 * @param {any} raw - Parsed overlay content.
 * @returns {{connection: {baseUrl: string, token: string}, home: {dir: string}, workspace: {enabled: boolean}, push: {token: string, target: {mode: 'archive'|'session'|'', sessionId: string}, model: {provider: string, model: string, reasoningEffort: string}, perception: {minLevel: string}}}} The normalised overlay.
 */
export function normalizeOverlay(raw) {
  const root = raw && typeof raw === 'object' ? raw : {}
  const connection = root.connection && typeof root.connection === 'object' ? root.connection : {}
  const home = root.home && typeof root.home === 'object' ? root.home : {}
  const workspace = root.workspace && typeof root.workspace === 'object' ? root.workspace : {}
  const push = root.push && typeof root.push === 'object' ? root.push : {}
  const target = push.target && typeof push.target === 'object' ? push.target : {}
  const model = push.model && typeof push.model === 'object' ? push.model : {}
  const perception = push.perception && typeof push.perception === 'object' ? push.perception : {}
  return {
    connection: {
      baseUrl: typeof connection.baseUrl === 'string' ? connection.baseUrl.trim() : '',
      token: typeof connection.token === 'string' ? connection.token : '',
    },
    home: {
      // 空 = 回退 config.workspace.dir，再回退插件默认目录
      dir: typeof home.dir === 'string' ? home.dir.trim() : '',
    },
    workspace: {
      // false = 不注册家庭工作区（会话归到「未分组」）；默认开启
      enabled: workspace.enabled !== false,
    },
    push: {
      token: typeof push.token === 'string' ? push.token : '',
      target: {
        mode: normalizePushTargetMode(target.mode),
        // 空 = 用「上一次触发 miloco 的会话」（仅 session 模式）
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
   * Write the overlay file atomically, merging with the disk state.
   * @param {any} value - Payload to store; omitted sections keep their current value.
   * @returns {Promise<void>} Resolves once the file is written.
   */
  async function write(value) {
    const existing = normalizeOverlay(await read())
    const incoming = value && typeof value === 'object' ? value : {}
    const merged = normalizeOverlay({
      connection: { ...existing.connection, ...(incoming.connection ?? {}) },
      home: { ...existing.home, ...(incoming.home ?? {}) },
      workspace: { ...existing.workspace, ...(incoming.workspace ?? {}) },
      push: {
        ...existing.push,
        ...(incoming.push ?? {}),
        target: { ...existing.push.target, ...(incoming.push?.target ?? {}) },
        model: { ...existing.push.model, ...(incoming.push?.model ?? {}) },
        perception: { ...existing.push.perception, ...(incoming.push?.perception ?? {}) },
      },
    })
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, file)
    await chmod(file, 0o600).catch(() => {})
    cache = { at: 0, value: undefined }
  }

  return { file, read, current, write }
}
