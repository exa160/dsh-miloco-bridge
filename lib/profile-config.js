/**
 * Profile-level plugin configuration writer.
 *
 * DSH's recommended place for a plugin's configuration is the **profile's
 * patch layer** (`~/.dsh/profiles/<profile>/cordis.patch.yml`) — the file
 * `dsh plugin` manages and `dsh --profile <p> --dump-config` shows. The
 * plugin's own `cordis.patch.yml` supplies the defaults; the profile layer
 * overrides them.
 *
 * This module performs a surgical, line-based edit of that file: it rewrites
 * the value of a named key inside the `dsh-miloco-bridge` entry and leaves every
 * other byte alone. It never re-serialises the whole YAML (no parser, no
 * reordering, no quoting surprises), and it writes through a temporary file
 * so a crash cannot truncate the profile.
 *
 * @module dsh-miloco-bridge/profile-config
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { expandHome } from './paths.js'

/**
 * Find the top-level entry block for one id.
 *
 * @param {string[]} lines - The file lines.
 * @param {string} id - The entry id.
 * @returns {{start: number, end: number} | null} The line range of the block.
 */
function findEntry(lines, id) {
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // 顶层条目：`- id: xxx`（缩进为零）。嵌套的 insert 列表缩进更深，不会命中。
    if (/^- id:\s*\S/.test(line) && line.slice(6).trim().replace(/^['"]|['"]$/g, '') === id) {
      start = i
      break
    }
  }
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^- (id|insert):/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/**
 * Rewrite one scalar key inside an entry block.
 *
 * @param {string[]} lines - The file lines (mutated in place).
 * @param {{start: number, end: number}} range - The entry block range.
 * @param {string} key - The key name.
 * @param {string} value - The new value (already quoted by the caller).
 * @returns {boolean} Whether the key existed and was rewritten.
 */
function setKey(lines, range, key, value) {
  const pattern = new RegExp(`^(\\s*)${key}:\\s*(.*)$`)
  for (let i = range.start; i < range.end; i += 1) {
    const match = pattern.exec(lines[i])
    if (!match) continue
    lines[i] = `${match[1]}${key}: ${value}`
    return true
  }
  return false
}

/**
 * Write configuration values into a profile patch file.
 *
 * @param {{file: string, id?: string, values: Record<string, string>}} options - Write options.
 * @returns {Promise<{ok: boolean, changed: string[], missing: string[]}>} The outcome.
 */
export async function writeProfileConfig(options) {
  const file = expandHome(options.file)
  const { values } = options
  const id = options.id ?? "dsh-miloco-bridge"
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    return { ok: false, changed: [], missing: Object.keys(values), error: String(error) }
  }
  const lines = text.split('\n')
  const range = findEntry(lines, id)
  if (!range) {
    return { ok: false, changed: [], missing: Object.keys(values), error: `patch 文件里找不到条目 ${id}` }
  }
  const changed = []
  const missing = []
  for (const [key, raw] of Object.entries(values)) {
    const value = typeof raw === 'string' && raw !== '' ? JSON.stringify(raw) : String(raw)
    if (setKey(lines, range, key, value)) changed.push(key)
    else missing.push(key)
  }
  if (changed.length === 0) {
    return { ok: false, changed, missing, error: '没有可更新的键' }
  }
  const output = lines.join('\n')
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, output, 'utf8')
  await rename(temporary, file)
  return { ok: true, changed, missing }
}

/**
 * Build a writer bound to one profile patch file.
 *
 * @param {{file: string, id?: string}} options - The profile patch file.
 * @returns {(values: Record<string, string>) => Promise<{ok: boolean, changed: string[], missing: string[], error?: string}>} The writer.
 */
export function createProfileConfigWriter(options) {
  return async (values) => writeProfileConfig({ ...options, values })
}
