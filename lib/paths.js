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

/**
 * Resolve the Miloco household workspace directory.
 *
 * The plugin owns this directory: it creates it and registers it as a host
 * Workspace so every conversation opened inside it belongs to the household
 * assistant. The default lives under the plugin's own data directory so the
 * plugin can manage (and clean up) everything it owns.
 *
 * @param {string} [configured] - Explicit directory; empty falls back to the
 *   plugin data directory.
 * @returns {string} Absolute household workspace directory.
 */
export function resolveMilocoHomeDir(configured) {
  const text = String(configured ?? '').trim()
  if (text) return expandHome(text)
  return join(resolveDshHome(), 'plugin-data', 'dsh-miloco-bridge', 'home')
}
