/**
 * Miloco household workspace.
 *
 * The household assistant owns exactly one directory: the workspace every
 * conversation of the 「Miloco 家庭助手」 preset lives in. The plugin creates
 * the directory, registers it as a host Workspace, retitles it, and keeps it
 * first in the registry order so the sidebar lists it above normal workspaces.
 *
 * The directory is configurable at runtime: `overlay.home.dir` wins over the
 * static `workspace.dir`. Registration is optional — a host without
 * `workspaceRegistry` still gets the directory, only the id stays empty.
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
 * @param {{ctx: any, config: any, overlay?: any, logger?: any}} options - Service options.
 * @returns {{
 *   dir: string,
 *   dirSource: 'overlay'|'config'|'default',
 *   workspaceId: string,
 *   title: string,
 *   agentPreset: string,
 *   ensure: () => Promise<any>,
 *   current: () => any,
 *   setDir: (value: string) => Promise<any>,
 * }} The service.
 */
export function createHomeService(options) {
  const { ctx, config } = options
  const overlay = options.overlay
  const log = options.logger ?? ctx?.logger
  const homeConfig = config?.workspace && typeof config.workspace === 'object'
    ? config.workspace
    : (config?.home && typeof config.home === 'object' ? config.home : {})

  const title = typeof homeConfig.title === 'string' && homeConfig.title.trim()
    ? homeConfig.title.trim()
    : DEFAULT_HOME_TITLE
  const agentPreset = typeof homeConfig.agentPreset === 'string' && homeConfig.agentPreset.trim()
    ? homeConfig.agentPreset.trim()
    : DEFAULT_HOME_AGENT_PRESET
  const staticDir = typeof homeConfig.dir === 'string' ? homeConfig.dir.trim() : ''

  /** @type {string} */
  let dir = resolveMilocoHomeDir(staticDir)
  /** @type {'overlay'|'config'|'default'} */
  let dirSource = staticDir ? 'config' : 'default'
  /** @type {string} */
  let workspaceId = ''
  /** @type {Promise<void> | null} */
  let pending = null

  /**
   * Read the current snapshot.
   * @returns {{path: string, workspaceId: string, title: string, agentPreset: string, dirSource: string}} The snapshot.
   */
  function current() {
    return { path: dir, workspaceId, title, agentPreset, dirSource }
  }

  /**
   * Resolve the effective directory from the overlay, then the static config.
   * @returns {Promise<{dir: string, source: 'overlay'|'config'|'default'}>} The effective directory.
   */
  async function effectiveDir() {
    if (overlay && typeof overlay.current === 'function') {
      try {
        const value = String((await overlay.current())?.home?.dir ?? '').trim()
        if (value) return { dir: resolveMilocoHomeDir(value), source: 'overlay' }
      } catch { /* fall through to the static config */ }
    }
    if (staticDir) return { dir: resolveMilocoHomeDir(staticDir), source: 'config' }
    return { dir: resolveMilocoHomeDir(''), source: 'default' }
  }

  /**
   * Move the household workspace before the first other workspace.
   * @param {any} registry - Host workspace registry.
   * @returns {Promise<void>} Resolves once the attempt finished.
   */
  async function pinFirst(registry) {
    if (!registry || !workspaceId || typeof registry.list !== 'function' || typeof registry.insertBefore !== 'function') return
    let items
    try {
      items = registry.list()
    } catch (error) {
      log?.warn?.(`dsh-miloco-bridge: 读取工作区列表失败：${error instanceof Error ? error.message : error}`)
      return
    }
    if (!Array.isArray(items) || items.length <= 1) return
    if (String(items[0]?.id ?? '') === workspaceId) return
    if (!items.some(item => String(item?.id ?? '') === workspaceId)) return
    const anchor = items.find(item => String(item?.id ?? '') !== workspaceId)
    if (!anchor) return
    try {
      await registry.insertBefore(workspaceId, anchor.id)
    } catch (error) {
      log?.warn?.(`dsh-miloco-bridge: 置顶家庭助手工作区失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Resolve the host workspace registry, tolerating a throwing `ctx.get`.
   * @returns {any} The registry, or undefined when the host has none.
   */
  function resolveRegistry() {
    try {
      return ctx?.get?.('workspaceRegistry')
    } catch (error) {
      log?.warn?.(`dsh-miloco-bridge: 读取工作区注册表失败：${error instanceof Error ? error.message : error}`)
      return undefined
    }
  }

  /**
   * Register the directory as a host workspace and keep its title.
   * @returns {Promise<void>} Resolves once the attempt finished.
   */
  async function register() {
    const targetDir = dir
    const registry = resolveRegistry()
    if (!registry || typeof registry.create !== 'function') return
    if (workspaceId) {
      // The user may have deleted the household workspace from the sidebar.
      // Re-register only when the registry list is readable and no longer
      // contains the id; an unreadable list must not churn the registration.
      let listed = null
      if (typeof registry.list === 'function') {
        try {
          const items = registry.list()
          if (Array.isArray(items)) listed = items
        } catch { /* treat an unreadable list as "still registered" */ }
      }
      if (!listed || listed.some(item => String(item?.id ?? '') === workspaceId)) return
      workspaceId = ''
    }
    try {
      const workspace = await registry.create(targetDir, title)
      // A concurrent setDir() may have moved `dir` while create() was pending;
      // never attach the old directory's id to the new directory.
      const createdId = String(workspace?.id ?? '')
      if (dir === targetDir) workspaceId = createdId
      if (workspaceId && workspace && typeof workspace.setTitle === 'function' && workspace.title !== title) {
        try {
          await workspace.setTitle(title)
        } catch (error) {
          log?.warn?.(`dsh-miloco-bridge: 重命名家庭助手工作区失败：${error instanceof Error ? error.message : error}`)
        }
      }
    } catch (error) {
      log?.warn?.(`dsh-miloco-bridge: 注册家庭助手工作区失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Resolve the directory and make sure it exists.
   * @returns {Promise<void>} Resolves once the attempt finished.
   */
  async function prepare() {
    const effective = await effectiveDir()
    if (effective.dir !== dir) {
      dir = effective.dir
      workspaceId = ''
    }
    dirSource = effective.source
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      log?.warn?.(`dsh-miloco-bridge: 创建家庭助手目录失败：${error instanceof Error ? error.message : error}`)
    }
  }

  /**
   * Create the directory, register the host workspace and re-pin its order.
   * Idempotent; the pin runs on every call so a user reordering the sidebar is
   * corrected on the next ensure.
   * @returns {Promise<any>} The snapshot.
   */
  function ensure() {
    if (!pending) {
      pending = prepare().finally(() => { pending = null })
    }
    return pending.then(async () => {
      await register()
      if (workspaceId) await pinFirst(resolveRegistry())
      return current()
    })
  }

  /**
   * Change the household directory at runtime.
   * @param {string} value - New directory; empty clears the overlay override.
   * @returns {Promise<any>} The new snapshot.
   */
  async function setDir(value) {
    if (!overlay || typeof overlay.write !== 'function') {
      throw new Error('运行时覆盖文件不可用，无法修改工作区目录')
    }
    const text = String(value ?? '').trim()
    await overlay.write({ home: { dir: text } })
    pending = null
    return ensure()
  }

  return {
    get dir() { return dir },
    get dirSource() { return dirSource },
    get workspaceId() { return workspaceId },
    get title() { return title },
    get agentPreset() { return agentPreset },
    ensure,
    current,
    setDir,
  }
}
