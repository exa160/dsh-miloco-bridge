/**
 * Miloco household workspace.
 *
 * The household assistant owns exactly one directory: the workspace every
 * conversation of the 「Miloco 家庭助手」 preset lives in. The plugin manages
 * it itself — it creates the directory and registers it as a host Workspace —
 * so the sidebar entry always points at a real, stable path.
 *
 * The host service is optional. A DSH deployment without `workspaceRegistry`
 * still gets the directory; only the workspace id stays empty, and the client
 * half then creates the workspace through the public API.
 *
 * @module dsh-miloco-bridge/home
 */

import { mkdir } from 'node:fs/promises'
import { resolveMilocoHomeDir } from './paths.js'

/** Default title of the household workspace. */
export const DEFAULT_HOME_TITLE = '家庭助手'

/** Default Agent preset used by the household workspace. */
export const DEFAULT_HOME_AGENT_PRESET = 'miloco'

/**
 * Create the household workspace service.
 *
 * @param {{ctx: any, config: any, logger?: any}} options - Service options.
 * @returns {{
 *   dir: string,
 *   workspaceId: string,
 *   title: string,
 *   agentPreset: string,
 *   ensure: () => Promise<{path: string, workspaceId: string, title: string, agentPreset: string}>,
 *   current: () => {path: string, workspaceId: string, title: string, agentPreset: string},
 * }} The service.
 */
export function createHomeService(options) {
  const { ctx, config } = options
  const log = options.logger ?? ctx?.logger
  // The household workspace is configured under `workspace`; a `home` object
  // is accepted too (the shape the design document describes).
  const homeConfig = config?.workspace && typeof config.workspace === 'object'
    ? config.workspace
    : (config?.home && typeof config.home === 'object' ? config.home : {})

  const dir = resolveMilocoHomeDir(homeConfig.dir)
  const title = typeof homeConfig.title === 'string' && homeConfig.title.trim()
    ? homeConfig.title.trim()
    : DEFAULT_HOME_TITLE
  const agentPreset = typeof homeConfig.agentPreset === 'string' && homeConfig.agentPreset.trim()
    ? homeConfig.agentPreset.trim()
    : DEFAULT_HOME_AGENT_PRESET

  /** @type {string} */
  let workspaceId = ''
  /** @type {Promise<any> | null} */
  let pending = null

  /**
   * Read the current state of the household workspace.
   * @returns {{path: string, workspaceId: string, title: string, agentPreset: string}} The snapshot.
   */
  function current() {
    return { path: dir, workspaceId, title, agentPreset }
  }

  /**
   * Register the directory as a host workspace.
   *
   * The registry is optional: a host without `workspaceRegistry` simply has
   * no workspace id. Registration is retried on every `ensure()` call while
   * the id is still empty, because the host service may become active after
   * this plugin was loaded.
   *
   * @returns {Promise<void>} Resolves once the attempt finished.
   */
  async function register() {
    if (workspaceId) return
    const registry = ctx?.get?.('workspaceRegistry')
    if (!registry || typeof registry.create !== 'function') return
    try {
      const workspace = await registry.create(dir, title)
      workspaceId = String(workspace?.id ?? '')
    } catch (error) {
      log?.warn?.(`dsh-miloco-bridge: 注册家庭助手工作区失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Create the directory and register the host workspace.
   *
   * Both steps are idempotent: the directory is created recursively and the
   * host registry returns the existing workspace for a known path. Failures
   * are logged and swallowed — the household assistant still works without a
   * registered workspace, and a broken directory must not take the plugin
   * (and with it every other Miloco capability) down.
   *
   * @returns {Promise<{path: string, workspaceId: string, title: string, agentPreset: string}>} The snapshot.
   */
  function ensure() {
    if (!pending) {
      pending = (async () => {
        try {
          await mkdir(dir, { recursive: true })
        } catch (error) {
          log?.warn?.(`dsh-miloco-bridge: 创建家庭助手目录失败：${error instanceof Error ? error.message : error}`)
        }
      })()
    }
    return pending.then(async () => {
      await register()
      return current()
    })
  }

  return {
    get dir() { return dir },
    get workspaceId() { return workspaceId },
    get title() { return title },
    get agentPreset() { return agentPreset },
    ensure,
    current,
  }
}
