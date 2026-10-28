/**
 * One-click Miloco deployment.
 *
 * The plugin is installable without Miloco. When the settings tab cannot
 * reach a backend it can:
 *
 * - start an already-installed Miloco (`miloco-cli service start`), or
 * - download the official release installer and run it without OpenClaw
 *   (`install.sh --skip-openclaw`), then install this package's adapter.
 *
 * The release installer is downloaded directly from GitHub first and then
 * through the configured mirrors. It is a self-contained script and downloads
 * its own release assets through the mirrors embedded in its manifest.
 *
 * This module never vendors upstream code: the release installer download and
 * install happen at runtime, on the owner's machine, after a button press.
 *
 * @module dsh-miloco-bridge/deploy
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMilocoConfig } from './miloco-client.js'
import {
  DEFAULT_GITHUB_MIRRORS,
  normalizeRepo,
  releaseInstallerUrls,
  viaMirror,
} from './github-release.js'

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
 * Mask credentials in command logs.
 * @param {string[]} args - Command arguments.
 * @returns {string[]} Arguments safe to log.
 */
export function redactCommandArgs(args) {
  const out = [...args]
  const secretFlags = new Set(['agent.auth_bearer', 'auth_bearer', '--token', '--bearer'])
  for (let index = 0; index < out.length - 1; index += 1) {
    if (secretFlags.has(out[index])) out[index + 1] = '<redacted>'
  }
  return out
}

/**
 * Force release-installer arguments.
 *
 * The old source flow used `--dev`; a release installer rejects it. OpenClaw is
 * used only to satisfy upstream platform detection, while `--skip-openclaw`
 * prevents its plugin from being installed.
 * @param {string[]} [raw] - Configured arguments.
 * @returns {string[]} Safe release-installer arguments.
 */
function normalizeInstallArgs(raw) {
  const args = Array.isArray(raw) ? raw.map(String) : []
  const filtered = args.filter(arg =>
    arg !== '--dev'
    && !arg.startsWith('--dev=')
    && !arg.startsWith('--agent-prepare')
    && !arg.startsWith('--agent-finish'))
  if (!filtered.includes('--skip-openclaw')) filtered.push('--skip-openclaw')
  if (!filtered.some(arg => arg === '--agent-platform' || arg.startsWith('--agent-platform='))) {
    filtered.push('--agent-platform=openclaw')
  }
  if (!filtered.some(arg => arg === '--lang' || arg.startsWith('--lang='))) {
    filtered.push('--lang=zh')
  }
  return filtered
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
  const githubMirrors = Array.isArray(deployConfig.githubMirrors) && deployConfig.githubMirrors.length
    ? deployConfig.githubMirrors.map(String)
    : DEFAULT_GITHUB_MIRRORS
  const installArgs = normalizeInstallArgs(deployConfig.installArgs)
  const repoUrl = `https://github.com/${normalizeRepo(repo)}`
  const downloadSite = String(deployConfig.downloadSite || '').trim()
    || (githubMirrors[0] ? viaMirror(githubMirrors[0], `${repoUrl}/releases/download`) : '')
  const installEnv = {
    UV_CACHE_DIR: join(milocoHome, '.uv-cache'),
    UV_INDEX: String(deployConfig.uvIndex || 'https://pypi.org/simple'),
    ...(downloadSite ? { MILOCO_DOWNLOAD_URL: downloadSite } : {}),
  }
  const logPath = expandHome(deployConfig.logPath || join(milocoHome, 'log', 'dsh-miloco-deploy.log'))
  const upgradeLogPath = expandHome(
    deployConfig.upgradeLogPath || join(milocoHome, 'log', 'dsh-miloco-upgrade.log'),
  )

  /** @type {{running: boolean, step: string, startedAt: string | null, exitCode: number | null}} */
  const state = { running: false, step: 'idle', startedAt: null, exitCode: null }
  /** @type {{running: boolean, step: string, startedAt: string | null, exitCode: number | null}} */
  const upgradeState = { running: false, step: 'idle', startedAt: null, exitCode: null }

  /**
   * Write a line into a log file.
   * @param {string} path - Log path.
   * @param {string} text - The line.
   */
  async function logTo(path, text) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `[${stamp}] ${text}\n`, { flag: 'a' })
  }

  /**
   * Write a line into the deployment log.
   * @param {string} text - The line.
   */
  async function logLine(text) {
    return logTo(logPath, text)
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
      const secrets = (extra.secrets ?? []).filter(Boolean)
      const sanitize = value => secrets.reduce(
        (text, secret) => text.split(secret).join('<redacted>'),
        String(value),
      )
      const commandLog = extra.logPath || logPath
      void logTo(commandLog, `$ ${command} ${redactCommandArgs(args).join(' ')}`)
      const child = spawn(command, args, {
        cwd: extra.cwd,
        env: {
          ...process.env,
          PATH: [join(homedir(), '.local', 'bin'), process.env.PATH].filter(Boolean).join(':'),
          MILOCO_HOME: milocoHome,
          ...(extra.env ?? {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const pump = stream => {
        stream.on('data', chunk => {
          for (const line of sanitize(chunk).split('\n')) {
            if (line.trim() !== '') void logTo(commandLog, line.trim())
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
   * Download the self-contained official release installer.
   * @returns {Promise<string>} Path to the installer script.
   */
  async function downloadReleaseInstaller(logTarget = logPath) {
    const target = join(milocoHome, '.dsh-release-install.sh')
    const urls = releaseInstallerUrls({ repo, mirrors: githubMirrors })
    const failures = []
    for (const url of urls) {
      await logTo(logTarget, `downloading release installer: ${url}`)
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': 'dsh-miloco-bridge' },
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const text = await response.text()
        if (!text.startsWith('#!')) throw new Error('响应不是 shell 安装脚本')
        await writeFile(target, text, { encoding: 'utf8', mode: 0o700 })
        await chmod(target, 0o700)
        return target
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${url}: ${message}`)
        await logTo(logTarget, `download failed: ${message}`)
      }
    }
    throw new Error(`无法下载 Miloco release 安装器：${failures.join('; ')}`)
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
      await run(opts.cli, ['config', 'set', 'agent.platform', 'dsh'], { cwd: milocoHome })
      await run(opts.cli, ['config', 'set', 'agent.webhook_url', webhook], { cwd: milocoHome })
      await run(opts.cli, ['config', 'set', 'agent.auth_bearer', opts.token], {
        cwd: milocoHome,
        secrets: [opts.token],
      })
      await run(opts.cli, ['service', 'restart'], { cwd: milocoHome })
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
        await logLine('=== dsh-miloco-bridge: 一键部署 Miloco 开始 ===')

        if (await healthy()) {
          state.step = 'already-running'
          await logLine('Miloco 已在 127.0.0.1:1810 运行，直接连接')
        } else {
          const cli = await findMilocoCli()
          if (cli && existsSync(join(milocoHome, 'config.json'))) {
            state.step = 'starting-existing'
            await logLine(`检测到已安装的 Miloco，尝试启动：${cli}`)
            await run(cli, ['service', 'start'], { cwd: milocoHome })
            await waitHealthy(DEFAULT_MILOCO_URL, 45_000)
          }

          if (!await healthy()) {
            state.step = 'downloading-installer'
            const installer = await downloadReleaseInstaller()
            state.step = 'installing'
            const prepare = await run('bash', [installer, '--agent-prepare', ...installArgs], {
              cwd: milocoHome,
              env: installEnv,
            })
            if (prepare !== 0) throw new Error(`Miloco release 安装器 prepare 返回 ${prepare}`)
            const finish = await run('bash', [installer, '--agent-finish', ...installArgs], {
              cwd: milocoHome,
              env: installEnv,
            })
            if (finish !== 0) throw new Error(`Miloco release 安装器 finish 返回 ${finish}`)
            state.step = 'starting-service'
            const cliAfter = await findMilocoCli()
            if (cliAfter) await run(cliAfter, ['service', 'start'], { cwd: milocoHome })
            if (!await waitHealthy(DEFAULT_MILOCO_URL, 120_000)) {
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
   * Run a mirror-backed upgrade through the same release installer as deploy.
   * @param {{origin?: string}} [opts] - Request origin.
   * @returns {Promise<{started: boolean, reason?: string, logPath?: string}>} Outcome.
   */
  async function startUpgrade(opts = {}) {
    if (upgradeState.running) {
      return { started: false, reason: 'already-running', logPath: upgradeLogPath }
    }
    if (state.running) {
      return { started: false, reason: 'deploy-running', logPath: upgradeLogPath }
    }
    upgradeState.running = true
    upgradeState.step = 'starting'
    upgradeState.startedAt = new Date().toISOString()
    upgradeState.exitCode = null
    const origin = String(opts.origin || '').replace(/\/+$/, '') || 'http://127.0.0.1:3080'

    void (async () => {
      try {
        await ensureWritableDir(milocoHome, 'MILOCO_HOME')
        await logTo(upgradeLogPath, '=== Miloco 升级开始 ===')
        upgradeState.step = 'downloading-installer'
        const installer = await downloadReleaseInstaller(upgradeLogPath)
        upgradeState.step = 'installing'
        const installOpts = { cwd: milocoHome, env: installEnv, logPath: upgradeLogPath }
        const prepare = await run('bash', [installer, '--agent-prepare', ...installArgs], installOpts)
        if (prepare !== 0) throw new Error(`Miloco release 安装器 prepare 返回 ${prepare}`)
        const finish = await run('bash', [installer, '--agent-finish', ...installArgs], installOpts)
        if (finish !== 0) throw new Error(`Miloco release 安装器 finish 返回 ${finish}`)
        upgradeState.step = 'starting-service'
        const cli = await findMilocoCli()
        if (cli) {
          await run(cli, ['service', 'start'], { cwd: milocoHome, logPath: upgradeLogPath })
        }
        if (!await waitHealthy(DEFAULT_MILOCO_URL, 120_000)) {
          throw new Error('Miloco 升级后没有在 127.0.0.1:1810 上响应')
        }
        upgradeState.step = 'wiring'
        const connection = await localConnection()
        const fileConfig = await readMilocoConfig(milocoHome)
        const existingToken = String(fileConfig?.agent?.auth_bearer ?? '').trim()
        const pushToken = existingToken || randomBytes(32).toString('base64url')
        await installAdapter({ origin, token: pushToken })
        await wireMiloco({ cli, origin, token: pushToken, connection })
        upgradeState.step = 'done'
        upgradeState.exitCode = 0
        await logTo(upgradeLogPath, '=== 升级完成 ===')
      } catch (error) {
        upgradeState.step = 'failed'
        upgradeState.exitCode = 1
        await logTo(upgradeLogPath, `升级异常：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        upgradeState.running = false
      }
    })()

    return { started: true, logPath: upgradeLogPath }
  }

  /**
   * @returns {any} Upgrade state for the settings API.
   */
  function upgradeStateView() {
    return { ...upgradeState, logPath: upgradeLogPath, milocoHome }
  }

  /**
   * Read the tail of the upgrade log.
   * @param {number} [lines] - Number of trailing lines.
   * @returns {Promise<string>} The log tail.
   */
  async function upgradeTail(lines = 60) {
    try {
      const text = await readFile(upgradeLogPath, 'utf8')
      const all = text.split('\n').filter(line => line.trim() !== '')
      return all.slice(-lines).join('\n')
    } catch {
      return ''
    }
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
    upgradeState: upgradeStateView,
    upgradeTail,
    startUpgrade,
  }
}
