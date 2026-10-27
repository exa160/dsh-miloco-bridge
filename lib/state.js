/**
 * Shared runtime state.
 *
 * The plugin is split into two halves in different scopes: the infra half is
 * global, while the tool half lives inside the Miloco agent preset. They
 * cannot share an in-memory object, so the little state they need lives in a
 * file:
 *
 * - `mode` — readonly / full, read by the tool half at activation;
 * - `lastSession` — the DSH session that last touched a Miloco tool. This is
 *   the default destination for an inbound push when no session is configured.
 *
 * Only session ids and timestamps are stored; no conversation content.
 *
 * @module dsh-miloco-bridge/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expandHome, resolveDshHome } from './paths.js'

/** Default state file location. */
export const DEFAULT_STATE_FILE = join(resolveDshHome(), 'miloco-plugin.state.json')

/** Maximum remembered sessions. */
const MAX_SESSIONS = 20

/** Minimum interval between two writes for the same active session. */
const SAME_SESSION_THROTTLE_MS = 60_000

/**
 * The Miloco agent's operating modes.
 *
 * - `readonly` — read tools only, writes are never registered;
 * - `full` — read + write tools.
 *
 * Older state files may contain `chat`; it is treated as `readonly` so an
 * upgrade never leaves a session without household tools.
 */
export const AGENT_MODES = ['readonly', 'full']

/**
 * Describe one mode for the UI and the documentation.
 * @param {string} mode - The mode id.
 * @returns {{id: string, label: string, description: string, writeTools: boolean}} The description.
 */
export function describeMode(mode) {
  const table = {
    readonly: {
      id: 'readonly',
      label: '只读模式',
      description: '可以看设备状态、问摄像头、查规则与档案，但动不了任何设备。',
      writeTools: false,
    },
    full: {
      id: 'full',
      label: '管家模式',
      description: '可以控制设备、触发场景、推送通知、建规则与任务。',
      writeTools: true,
    },
  }
  return table[mode] ?? table.readonly
}

/**
 * Normalise the session history stored in old and new state files.
 * @param {any} value - Raw `sessions` value.
 * @returns {{id: string, at: number}[]} Session entries, newest first.
 */
function normalizeSessionEntries(value) {
  if (!Array.isArray(value)) return []
  const entries = []
  for (const item of value) {
    if (typeof item === 'string' && item) entries.push({ id: item, at: 0 })
    else if (item && typeof item === 'object' && typeof item.id === 'string' && item.id) {
      entries.push({ id: item.id, at: Number.isFinite(item.at) ? item.at : 0 })
    }
  }
  return entries
}

/**
 * Create the shared state store.
 *
 * @param {{file?: string, logger?: any}} [options] - Store options.
 * @returns {{file: string, read: () => Promise<any>, write: (patch: any) => Promise<any>}} The store.
 */
export function createStateStore(options = {}) {
  const file = expandHome(options.file || DEFAULT_STATE_FILE)
  const logger = options.logger

  /**
   * Read the state file.
   * @returns {Promise<any>} The parsed state (empty object when absent).
   */
  async function read() {
    try {
      const text = await readFile(file, 'utf8')
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /**
   * Merge a patch into the state file and persist it.
   * @param {any} patch - The fields to merge.
   * @returns {Promise<any>} The new state.
   */
  async function write(patch) {
    const current = await read()
    const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
    try {
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } catch (error) {
      logger?.warn?.(`dsh-miloco-bridge: 写状态文件失败：${error instanceof Error ? error.message : error}`)
    }
    return next
  }

  return { file, read, write }
}

/**
 * Record a session as "the last one that touched Miloco".
 *
 * @param {{file: string, read: () => Promise<any>, write: (patch: any) => Promise<any>}} store - The state store.
 * @param {string} sessionId - The session id.
 * @returns {Promise<void>} Resolves once the state is persisted.
 */
export async function noteSession(store, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  const current = await store.read()
  const now = Date.now()
  const lastAt = Number.isFinite(current.lastSessionAt) ? current.lastSessionAt : 0
  if (current.lastSession === sessionId && now - lastAt < SAME_SESSION_THROTTLE_MS) return
  const entries = normalizeSessionEntries(current.sessions).filter(entry => entry.id !== sessionId)
  entries.unshift({ id: sessionId, at: now })
  await store.write({
    lastSession: sessionId,
    lastSessionAt: now,
    sessions: entries.slice(0, MAX_SESSIONS),
  })
}

/**
 * Read the session that last touched Miloco.
 *
 * @param {{file: string, read: () => Promise<any>}} store - The state store.
 * @returns {Promise<{last: string, lastAt: number, sessions: string[], entries: {id: string, at: number}[]}>} The recorded sessions.
 */
export async function readSessions(store) {
  const current = await store.read()
  const entries = normalizeSessionEntries(current.sessions)
  if (entries.length === 0 && typeof current.lastSession === 'string' && current.lastSession) {
    entries.push({ id: current.lastSession, at: Number.isFinite(current.lastSessionAt) ? current.lastSessionAt : 0 })
  }
  return {
    last: typeof current.lastSession === 'string' ? current.lastSession : '',
    lastAt: Number.isFinite(current.lastSessionAt) ? current.lastSessionAt : 0,
    sessions: entries.map(entry => entry.id),
    entries,
  }
}

/**
 * Forget recorded sessions (used when Miloco resets a session key).
 * @param {{file: string, read: () => Promise<any>, write: (patch: any) => Promise<any>}} store - The state store.
 * @param {string[]} sessionIds - Session ids to forget; empty means all.
 * @returns {Promise<void>} Resolves once the state is persisted.
 */
export async function clearSessions(store, sessionIds = []) {
  const current = await store.read()
  const remove = new Set(sessionIds.filter(id => typeof id === 'string' && id))
  const entries = normalizeSessionEntries(current.sessions)
    .filter(entry => !remove.has(entry.id))
  const last = typeof current.lastSession === 'string' ? current.lastSession : ''
  const keepLast = last && !remove.has(last)
  await store.write({
    sessions: entries,
    ...(keepLast ? {} : { lastSession: '', lastSessionAt: 0 }),
  })
}
