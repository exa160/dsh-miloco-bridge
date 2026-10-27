/**
 * Uninstall Miloco (not the DSH plugin itself).
 *
 * The destructive parts are explicit and path-guarded:
 *
 * - always: stop the Miloco service, remove the DSH adapter, clear the
 *   plugin's connection and push token;
 * - `removeSource`: delete the cloned source directory, only when it lives
 *   under a DSH-owned/data root;
 * - `removeData`: delete `$MILOCO_HOME` (account binding, database, perception
 *   records), only when it is a subdirectory of the user's home.
 *
 * The caller must send the literal confirmation string `UNINSTALL`.
 *
 * @module dsh-miloco-bridge/uninstall
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { expandHome, resolveDshHome } from './paths.js'

/** Literal confirmation required by the API and UI. */
export const UNINSTALL_CONFIRM = 'UNINSTALL'

/**
 * Check that `target` is a strict child of `root`.
 * @param {string} target - Candidate path.
 * @param {string} root - Allowed root.
 * @returns {boolean} Whether the target is inside the root.
 */
function isInside(target, root) {
  const a = resolve(target)
  const b = resolve(root)
  return a !== b && a.startsWith(`${b}${sep}`)
}

/**
 * Default command runner.
 * @param {string} command - Executable.
 * @param {string[]} args - Arguments.
 * @param {number} timeoutMs - Kill timeout.
 * @returns {Promise<{code: number, output: string}>} Result.
 */
function defaultRunner(command, args, timeoutMs = 15_000) {
  return new Promise(resolvePromise => {
    let output = ''
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const pump = stream => stream.on('data', chunk => { output += String(chunk) })
    pump(child.stdout)
    pump(child.stderr)
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 0, output: output.trim() })
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ code: 1, output: error.message })
    })
  })
}

/**
 * Create the uninstall service.
 *
 * @param {{config: any, overlay?: any, logger?: any, unitPath?: string, runner?: (command: string, args: string[], timeoutMs?: number) => Promise<{code: number, output: string}>}} options - Service options.
 * @returns {{preview: () => any, run: (opts: {confirm: string, removeData?: boolean, removeSource?: boolean}) => Promise<any>}} The service.
 */
export function createUninstallService(options) {
  const { config } = options
  const log = options.logger
  const runner = options.runner ?? defaultRunner
  const dshHome = resolveDshHome()
  const milocoHome = expandHome(config.home || '~/.miloco')
  const sourceDir = expandHome(
    config.deploy?.sourceDir || join(dshHome, 'plugin-data', 'dsh-miloco-bridge', 'xiaomi-miloco'),
  )
  const adapterDir = join(milocoHome, 'agent_platform', 'dsh')
  const supervisorConf = join(milocoHome, 'supervisord.conf')
  const supervisorctl = join(sourceDir, 'backend', '.venv', 'bin', 'supervisorctl')
  const unitPath = options.unitPath ?? join(homedir(), '.config', 'systemd', 'user', 'miloco.service')
  const sourceRoots = [
    join(dshHome, 'plugin-data', 'dsh-miloco-bridge'),
    join(dshHome, 'miloco-deploy'),
  ]
  const dataRoots = [
    join(homedir(), '.miloco'),
    join(homedir(), '.openclaw', 'miloco'),
  ]

  /**
   * Describe what an uninstall would touch.
   * @returns {any} Preview payload.
   */
  function preview() {
    return {
      milocoHome,
      sourceDir,
      adapterDir,
      supervisorConf,
      unitPath,
      sourceRemovable: sourceRoots.some(root => isInside(sourceDir, root)),
      dataRemovable: dataRoots.some(root => resolve(milocoHome) === resolve(root)),
    }
  }

  /**
   * Stop the service through systemd when the unit exists, otherwise through
   * supervisorctl.
   * @returns {Promise<{stopped: boolean, detail: string}>} Stop result.
   */
  async function stopService() {
    if (existsSync(unitPath)) {
      const result = await runner('systemctl', ['--user', 'stop', 'miloco.service'])
      await runner('systemctl', ['--user', 'disable', 'miloco.service'])
      return {
        stopped: result.code === 0,
        detail: result.code === 0 ? 'systemd unit stopped' : result.output,
      }
    }
    if (existsSync(supervisorConf)) {
      if (existsSync(supervisorctl)) {
        await runner(supervisorctl, ['-c', supervisorConf, 'stop', 'miloco-backend'])
        const shutdown = await runner(supervisorctl, ['-c', supervisorConf, 'shutdown'])
        return {
          stopped: shutdown.code === 0,
          detail: shutdown.code === 0 ? 'supervisord stopped' : shutdown.output,
        }
      }
      const stopped = await runner('supervisorctl', ['-c', supervisorConf, 'shutdown'])
      return { stopped: stopped.code === 0, detail: stopped.output }
    }
    return { stopped: false, detail: '未找到 miloco.service 或 supervisord.conf' }
  }

  /**
   * Run the uninstall.
   * @param {{confirm: string, removeData?: boolean, removeSource?: boolean}} opts - Options.
   * @returns {Promise<any>} Result.
   */
  async function run(opts = {}) {
    if (opts.confirm !== UNINSTALL_CONFIRM) {
      throw new Error(`确认文本必须是 ${UNINSTALL_CONFIRM}`)
    }
    const removeData = opts.removeData === true
    const removeSource = opts.removeSource === true
    const warnings = []

    if (removeData && !dataRoots.some(root => resolve(milocoHome) === resolve(root))) {
      throw new Error(
        `拒绝删除自定义 MILOCO_HOME：${milocoHome}。`
        + `允许删除：${dataRoots.join(' / ')}；其它路径请手动删除。`,
      )
    }
    if (removeSource && !sourceRoots.some(root => isInside(sourceDir, root))) {
      throw new Error(
        `拒绝删除不在 DSH 数据目录下的源码：${sourceDir}。`
        + `允许范围：${sourceRoots.join(' / ')}；请手动删除自定义路径。`,
      )
    }
    if (!isAbsolute(milocoHome) || milocoHome === homedir() || milocoHome === sep) {
      throw new Error(`不安全的 MILOCO_HOME：${milocoHome}`)
    }

    const stop = await stopService()

    let removedAdapter = false
    try {
      await rm(adapterDir, { recursive: true, force: true })
      removedAdapter = true
    } catch (error) {
      warnings.push(`移除 adapter 失败：${error instanceof Error ? error.message : error}`)
    }

    let clearedConnection = false
    if (options.overlay) {
      const current = await options.overlay.current()
      await options.overlay.write({
        connection: { baseUrl: '', token: '' },
        push: {
          token: '',
          target: current.push.target,
          model: current.push.model,
        },
      })
      clearedConnection = true
    }

    let removedSource = false
    if (removeSource) {
      try {
        await rm(sourceDir, { recursive: true, force: true })
        removedSource = true
      } catch (error) {
        warnings.push(`删除源码失败：${error instanceof Error ? error.message : error}`)
      }
    }

    let removedData = false
    if (removeData) {
      try {
        await rm(milocoHome, { recursive: true, force: true })
        removedData = true
      } catch (error) {
        warnings.push(`删除数据失败：${error instanceof Error ? error.message : error}`)
      }
    }

    log?.info?.(
      `dsh-miloco-bridge: uninstall stopped=${stop.stopped} adapter=${removedAdapter} `
      + `source=${removedSource} data=${removedData}`,
    )

    return {
      ok: true,
      stopped: stop.stopped,
      stopDetail: stop.detail,
      clearedConnection,
      removedAdapter,
      removedSource,
      removedData,
      ...(warnings.length ? { warnings } : {}),
      note: [
        stop.stopped ? '已停止 Miloco 服务。' : `停止服务未确认：${stop.detail}`,
        '已移除 DSH adapter 并清空插件连接/推送令牌。',
        removedSource ? '已删除源码目录。' : (removeSource ? '源码未删除。' : ''),
        removedData ? '已删除 Miloco 数据目录。' : (removeData ? '数据未删除。' : ''),
        ...warnings,
      ].filter(Boolean).join(' '),
    }
  }

  return { preview, run }
}
