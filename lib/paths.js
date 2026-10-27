/**
 * Path helpers.
 *
 * Loader configuration is YAML, so `~` reaches the plugin as a literal string.
 * Node's fs APIs do not expand it; every path that comes from configuration
 * goes through {@link expandHome} first.
 *
 * @module dsh-miloco-bridge/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Expand a leading `~` or `~/`.
 * @param {string} value - Raw path.
 * @returns {string} Absolute path (or the original value when not a home path).
 */
export function expandHome(value) {
  const text = String(value ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Resolve the DSH home directory, honouring `$DSH_HOME`.
 * @returns {string} Absolute DSH home.
 */
export function resolveDshHome() {
  const raw = String(process.env.DSH_HOME ?? '').trim()
  return raw ? expandHome(raw) : join(homedir(), '.dsh')
}
