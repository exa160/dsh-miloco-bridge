/**
 * One-click Miloco deployment.
 *
 * The plugin is installable without Miloco. When the settings tab cannot
 * reach a backend it can:
 *
 * - start an already-installed Miloco (`miloco-cli service start`), or
 * - clone the upstream repository into a configurable directory and run its
 *   own installer (`scripts/install.sh --dev --skip-openclaw`).
 *
 * It then installs this package's `agent_platform` adapter, points Miloco's
 * webhook at DSH, and writes the runtime overlay so the plugin can talk to the
 * new backend immediately.
 *
 * This module never vendors upstream code: the clone and install happen at
 * runtime, on the owner's machine, after an explicit button press.
 *
 * @module dsh-miloco-bridge/deploy
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMilocoConfig } from './miloco-client.js'

/** Upstream source repository used when no local checkout exists. */
export const MILOCO_REPO = 'https://github.com/XiaoMi/xiaomi-miloco'

/** Bundled adapter shipped with this package. */
const ADAPTER_SOURCE = fileURLToPath(new URL('../adapter/dsh_adapter.py', import.meta.url))

/** Default local Miloco endpoint. */
const DEFAULT_MILOCO_URL = 'http://127.0.0.1:1810'

/**
 * Expand a leading `~`.
 * @param {string} value - Path.
 * @returns {string} Expanded path.
 */
function expandHome(value) {
  const text = String(value ?? '').trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/')) return join(homedir(), text.slice(2))
  return text
}

/**
 * Create a directory and prove the DSH process can write to it.
 * @param {string} dir - Directory path.
 * @param {string} label - Human-readable label for errors.
 * @returns {Promise<void>} Resolves when writable.
 */
async function ensureWritableDir(dir, label) {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await access(dir, constants.W_OK)
  } catch (error) {
    throw new Error(
      `${label} 不可写：${dir}。请把 deploy.sourceDir / MILOCO_HOME 配置到 DSH 进程用户可读写的目录：`
      + `${error instanceof Error ? error.message : error}`,
    )
  }
}

/**
 * Create the deployment service.
 *
 * @param {{config: any, logger?: any, overlay?: any}} options - Service options.
 * @returns {{
 *   state: () => any,
 *   tail: (lines?: number) => Promise<string>,
 *   start: (opts?: {origin?: string}) => Promise<any>,
 * }} The service.
 */
export function createDeployService(options) {
  const { config } = options
  const log = options.logger
  const deployConfig = config.deploy ?? {}
  const sourceDir = expandHome(
    deployConfig.sourceDir || '~/.dsh/plugin-data/dsh-miloco-bridge/xiaomi-miloco',
  )
  const milocoHome = expandHome(config.home || '~/.miloco')
  const repo = String(deployConfig.repo || MILOCO_REPO)
  const installArgs = Array.isArray(deployConfig.installArgs) && deployConfig.installArgs.length
    ? deployConfig.installArgs.map(String)
    : ['--dev', '--skip-openclaw']
  const logPath = expandHome(deployConfig.logPath || join(milocoHome, 'log', 'dsh-miloco-deploy.log'))

  /** @type {{running: boolean, step: string, startedAt: string | null, exitCode: number | null}} */
  const state = { running: false, step: 'idle', startedAt: null, exitCode: null }

  /**
   * Write a line into the deployment log.
   * @param {string} text - The line.
   */
  async function logLine(text) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    await mkdir(dirname(logPath), { recursive: true })
    await writeFile(logPath, `[${stamp}] ${text}\n`, { flag: 'a' })
  }

  /**
   * Run one executable with arguments, streaming output into the log.
   * @param {string} command - Executable.
   * @param {string[]} args - Arguments (never a shell string).
   * @param {{cwd?: string, env?: Record<string, string>}} [extra] - Process options.
   * @returns {Promise<number>} The exit code.
   */
  function run(command, args, extra = {}) {
    return new Promise(resolve => {
      void logLine(`$ ${command} ${args.join(' ')}`)
      const child = spawn(command, args, {
        cwd: extra.cwd,
        env: { ...process.env, MILOCO_HOME: milocoHome, ...(extra.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const pump = stream => {
        stream.on('data', chunk => {
          for (const line of String(chunk).split('\n')) {
            if (line.trim() !== '') void logLine(line.trim())
          }
        })
      }
      pump(child.stdout)
      pump(child.stderr)
      child.on('close', code => resolve(code ?? 0))
      child.on('error', error => {
        void logLine(`command failed: ${error.message}`)
        resolve(1)
      })
    })
  }

  /**
   * Locate `miloco-cli`.
   * @returns {Promise<string>} Executable path, or an empty string.
   */
  async function findMilocoCli() {
    const candidates = [
      process.env.MILOCO_CLI || '',
      join(sourceDir, 'backend', '.venv', 'bin', 'miloco-cli'),
      join(homedir(), '.local', 'bin', 'miloco-cli'),
    ].filter(Boolean)
    for (const candidate of candidates) {
      try {
        await access(candidate)
        return candidate
      } catch { /* next */ }
    }
    // Fall back to PATH.
    const code = await run('bash', ['-lc', 'command -v miloco-cli'], { cwd: homedir() })
    if (code === 0) return 'miloco-cli'
    return ''
  }

  /**
   * Probe the Miloco health endpoint.
   * @param {string} baseUrl - Backend base URL.
   * @returns {Promise<boolean>} Whether it answered.
   */
  async function healthy(baseUrl = DEFAULT_MILOCO_URL) {
    try {
      const response = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(3_000),
      })
      // 401/403 still proves the service is up; only transport and 5xx mean
      // "not ready" for the purpose of this check.
      return response.status < 500
    } catch {
      return false
    }
  }

  /**
   * Wait until the backend answers or the deadline passes.
   * @param {string} baseUrl - Backend base URL.
   * @param {number} timeoutMs - Maximum wait.
   * @returns {Promise<boolean>} Whether it became healthy.
   */
  async function waitHealthy(baseUrl, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await healthy(baseUrl)) return true
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    return false
  }

  /**
   * Resolve the effective Miloco URL/token from `$MILOCO_HOME/config.json`.
   * @returns {Promise<{baseUrl: string, token: string}>} Connection settings.
   */
  async function localConnection() {
    const fileConfig = await readMilocoConfig(milocoHome)
    const server = fileConfig.server ?? {}
    const baseUrl = String(server.url || DEFAULT_MILOCO_URL).replace(/\/+$/, '')
    const token = String(server.token ?? '')
    return { baseUrl, token }
  }

  /**
   * Install this package's adapter into Miloco.
   * @param {{origin: string, token: string}} opts - Adapter options.
   * @returns {Promise<void>} Resolves when the adapter is installed.
   */
  async function installAdapter(opts) {
    const targetDir = join(milocoHome, 'agent_platform', 'dsh')
    await mkdir(targetDir, { recursive: true })
    await copyFile(ADAPTER_SOURCE, join(targetDir, 'adapter.py'))
    const configPath = join(targetDir, 'config.yaml')
    let text = ''
    try {
      text = await readFile(configPath, 'utf8')
    } catch {
      text = ''
    }
    const desired = new Map([
      ['webhook_url', JSON.stringify(`${opts.origin}/miloco/webhook`)],
      ['auth_bearer', JSON.stringify(opts.token)],
      ['include_home_profile', 'true'],
      ['home_profile_max_chars', '4000'],
    ])
    const lines = text.split('\n').filter(line => line.trim() !== '')
    for (const [key, value] of desired) {
      const index = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*:`).test(line))
      const next = `${key}: ${value}`
      if (index >= 0) lines[index] = next
      else lines.push(next)
    }
    await writeFile(configPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
    await logLine(`adapter installed at ${targetDir}`)
  }

  /**
   * Point Miloco at DSH and persist the same token in the overlay.
   * @param {{cli: string, origin: string, token: string, connection: {baseUrl: string, token: string}}} opts - Wiring options.
   * @returns {Promise<void>} Resolves when configured.
   */
  async function wireMiloco(opts) {
    const webhook = `${opts.origin}/miloco/webhook`
    if (opts.cli) {
      await run(opts.cli, ['config', 'set', 'agent.platform', 'dsh'], { cwd: sourceDir })
      await run(opts.cli, ['config', 'set', 'agent.webhook_url', webhook], { cwd: sourceDir })
      await run(opts.cli, ['config', 'set', 'agent.auth_bearer', opts.token], { cwd: sourceDir })
      await run(opts.cli, ['service', 'restart'], { cwd: sourceDir })
    }
    if (options.overlay) {
      const current = await options.overlay.current()
      await options.overlay.write({
        connection: { baseUrl: opts.connection.baseUrl, token: opts.connection.token },
        push: {
          token: opts.token,
          target: current.push.target,
          model: current.push.model,
        },
      })
    }
  }

  /**
   * Start the deployment job.
   * @param {{origin?: string}} [opts] - Request origin, used for the webhook URL.
   * @returns {Promise<{started: boolean, reason?: string, logPath?: string}>} The outcome.
   */
  async function start(opts = {}) {
    if (state.running) return { started: false, reason: 'already-running', logPath }
    state.running = true
    state.step = 'starting'
    state.startedAt = new Date().toISOString()
    state.exitCode = null

    const origin = String(opts.origin || '').replace(/\/+$/, '') || 'http://127.0.0.1:3080'

    void (async () => {
      try {
        await ensureWritableDir(milocoHome, 'MILOCO_HOME')
        await ensureWritableDir(dirname(sourceDir), 'deploy.sourceDir 的父目录')
        await logLine('=== dsh-miloco-bridge: 一键部署 Miloco 开始 ===')

        if (await healthy()) {
          state.step = 'already-running'
          await logLine('Miloco 已在 127.0.0.1:1810 运行，直接连接')
        } else {
          const cli = await findMilocoCli()
          if (cli && existsSync(join(milocoHome, 'config.json'))) {
            state.step = 'starting-existing'
            await logLine(`检测到已安装的 Miloco，尝试启动：${cli}`)
            await run(cli, ['service', 'start'], { cwd: sourceDir })
            await waitHealthy(DEFAULT_MILOCO_URL, 45_000)
          }

          if (!await healthy()) {
            state.step = 'preparing-source'
            if (!existsSync(join(sourceDir, 'scripts', 'install.sh'))) {
              if (!/^https:\/\//i.test(repo)) {
                throw new Error('deploy.repo 必须是 https:// 地址')
              }
              await mkdir(dirname(sourceDir), { recursive: true })
              await logLine(`cloning ${repo} -> ${sourceDir}`)
              const clone = await run('git', ['clone', '--depth', '1', repo, sourceDir], { cwd: homedir() })
              if (clone !== 0) throw new Error(`git clone 失败（exit ${clone}）`)
            }
            state.step = 'installing'
            const install = await run('bash', ['scripts/install.sh', ...installArgs], { cwd: sourceDir })
            if (install !== 0) throw new Error(`Miloco 安装器返回 ${install}`)
            state.step = 'starting-service'
            const cliAfter = await findMilocoCli()
            if (cliAfter) await run(cliAfter, ['service', 'start'], { cwd: sourceDir })
            if (!await waitHealthy(DEFAULT_MILOCO_URL, 90_000)) {
              throw new Error('Miloco 安装完成但没有在 127.0.0.1:1810 上响应')
            }
          }
        }

        state.step = 'wiring'
        const connection = await localConnection()
        const cli = await findMilocoCli()
        const fileConfig = await readMilocoConfig(milocoHome)
        const existingToken = String(fileConfig?.agent?.auth_bearer ?? '').trim()
        const pushToken = existingToken || randomBytes(32).toString('base64url')

        await installAdapter({ origin, token: pushToken })
        await wireMiloco({ cli, origin, token: pushToken, connection })

        state.step = 'done'
        state.exitCode = 0
        await logLine('=== 部署完成 ===')
        await logLine(`连接地址：${connection.baseUrl}`)
        await logLine('推送令牌已写入 DSH 插件 overlay；Miloco 已指向 DSH webhook。')
        await logLine('下一步：在 Miloco 面板绑定米家账号并开启摄像头感知。')
      } catch (error) {
        state.step = 'failed'
        state.exitCode = 1
        await logLine(`部署异常：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        state.running = false
        log?.info?.('dsh-miloco-bridge: 一键部署任务结束')
      }
    })()

    return { started: true, logPath }
  }

  /**
   * Read the tail of the deployment log.
   * @param {number} [lines] - Number of trailing lines.
   * @returns {Promise<string>} The log tail.
   */
  async function tail(lines = 60) {
    try {
      const text = await readFile(logPath, 'utf8')
      const all = text.split('\n').filter(line => line.trim() !== '')
      return all.slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  return {
    state: () => ({
      ...state,
      logPath,
      sourceDir,
      milocoHome,
      repo,
    }),
    tail,
    start,
  }
}
