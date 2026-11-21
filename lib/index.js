/**
 * dsh-miloco-bridge — infra half.
 *
 * This half is global: it must exist no matter which Agent is talking.
 *
 * - `POST /miloco/webhook` receives Miloco's proactive events.
 * - `/dsh-miloco-bridge/api/*` backs the 「设置 → 插件 → Miloco」 tab.
 * - It can deploy Miloco or connect to an existing instance.
 *
 * The Miloco tools and skills live in the other half
 * (`lib/tools-entry.js`), mounted inside the dedicated `miloco` Agent preset.
 *
 * @module dsh-miloco-bridge
 */

import { join } from 'node:path'
import { createMilocoClient, resolveMilocoHome } from './miloco-client.js'
import { createMilocoTools } from './tools.js'
import { normalizePerceptionLevel } from './perception.js'
import { resolveDshHome } from './paths.js'
import {
  createHomeService,
  DEFAULT_HOME_AGENT_PRESET,
  DEFAULT_HOME_TITLE,
} from './home.js'
import { createOverlay, DEFAULT_OVERLAY_FILE, normalizePushTargetMode } from './overlay.js'
import {
  clearSessions,
  createStateStore,
  DEFAULT_STATE_FILE,
  noteSession,
  readSessions,
} from './state.js'
import { registerSettingsApi } from './settings-api.js'
import { createDeployService } from './deploy.js'
import { createUninstallService } from './uninstall.js'
import { createProfileConfigWriter } from './profile-config.js'

/** Cordis plugin name. */
export const name = 'dsh-miloco-bridge'

/** Services the plugin consumes at activation. */
export const inject = ['webServer']

/**
 * Normalise the raw plugin configuration.
 * @param {Record<string, any>} raw - Raw configuration from the loader.
 * @returns {any} The normalised configuration.
 */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const pushRaw = config.push && typeof config.push === 'object' ? config.push : {}
  const targetRaw = pushRaw.target && typeof pushRaw.target === 'object' ? pushRaw.target : {}
  const modelRaw = pushRaw.model && typeof pushRaw.model === 'object' ? pushRaw.model : {}
  const deployRaw = config.deploy && typeof config.deploy === 'object' ? config.deploy : {}
  const timeoutMs = Number(config.timeoutMs)
  // `home` keeps its original meaning: the Miloco **backend** install
  // directory. The household workspace lives under its own `workspace` key so
  // existing configurations (and the preset's own `home`) keep working.
  // A `home` *object* is also accepted as the household workspace, which is
  // the shape the design document describes.
  const workspaceRaw = config.workspace && typeof config.workspace === 'object'
    ? config.workspace
    : (config.home && typeof config.home === 'object' ? config.home : {})
  const workspaceDir = typeof workspaceRaw.dir === 'string' ? workspaceRaw.dir.trim() : ''

  return {
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    token: typeof config.token === 'string' ? config.token : '',
    // Miloco 后端安装目录。
    home: typeof config.home === 'string' ? config.home : resolveMilocoHome(process.env.MILOCO_HOME),
    // 家庭助手专属工作区
    workspace: {
      dir: workspaceDir,
      title: typeof workspaceRaw.title === 'string' && workspaceRaw.title.trim()
        ? workspaceRaw.title.trim()
        : DEFAULT_HOME_TITLE,
      agentPreset: typeof workspaceRaw.agentPreset === 'string' && workspaceRaw.agentPreset.trim()
        ? workspaceRaw.agentPreset.trim()
        : DEFAULT_HOME_AGENT_PRESET,
    },
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
    readOnly: config.readOnly !== false,
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    overlayFile: typeof config.overlayFile === 'string' && config.overlayFile
      ? config.overlayFile
      : DEFAULT_OVERLAY_FILE,
    stateFile: typeof config.stateFile === 'string' && config.stateFile
      ? config.stateFile
      : DEFAULT_STATE_FILE,
    profilePatch: typeof config.profilePatch === 'string' ? config.profilePatch : '',
    push: {
      enabled: pushRaw.enabled !== false,
      path: typeof pushRaw.path === 'string' && pushRaw.path.startsWith('/')
        ? pushRaw.path
        : '/miloco/webhook',
      token: typeof pushRaw.token === 'string' ? pushRaw.token : '',
      waitForResult: pushRaw.waitForResult !== false,
      target: {
        // archive = 专用归档会话；session = 指定会话，空则回退上次 Miloco 会话
        mode: normalizePushTargetMode(targetRaw.mode) || 'archive',
        sessionId: typeof targetRaw.sessionId === 'string' ? targetRaw.sessionId.trim() : '',
        // 新建推送会话时挂哪个 Agent 预设（默认 miloco —— 推送进来的对话要能调米家工具）
        agentPreset: typeof targetRaw.agentPreset === 'string'
          ? targetRaw.agentPreset
          : 'miloco',
      },
      model: {
        provider: typeof modelRaw.provider === 'string' ? modelRaw.provider.trim() : '',
        model: typeof modelRaw.model === 'string' ? modelRaw.model.trim() : '',
        reasoningEffort: typeof modelRaw.reasoningEffort === 'string' ? modelRaw.reasoningEffort.trim() : '',
      },
      perception: {
        minLevel: normalizePerceptionLevel(pushRaw.perception?.minLevel),
      },
    },
    deploy: {
      repo: typeof deployRaw.repo === 'string' && deployRaw.repo
        ? deployRaw.repo
        : 'https://github.com/XiaoMi/xiaomi-miloco',
      sourceDir: typeof deployRaw.sourceDir === 'string' && deployRaw.sourceDir
        ? deployRaw.sourceDir
        : join(resolveDshHome(), 'plugin-data', 'dsh-miloco-bridge', 'xiaomi-miloco'),
      installArgs: Array.isArray(deployRaw.installArgs)
        ? deployRaw.installArgs.map(String)
        : ['--skip-openclaw', '--agent-platform=openclaw', '--lang=zh'],
      githubMirrors: Array.isArray(deployRaw.githubMirrors)
        ? deployRaw.githubMirrors.map(String).filter(Boolean)
        : ['https://gh-proxy.com/', 'https://gh-proxy.org/'],
      githubApi: typeof deployRaw.githubApi === 'string' && deployRaw.githubApi
        ? deployRaw.githubApi
        : 'https://api.github.com',
      downloadSite: typeof deployRaw.downloadSite === 'string' ? deployRaw.downloadSite : '',
      uvIndex: typeof deployRaw.uvIndex === 'string' && deployRaw.uvIndex
        ? deployRaw.uvIndex
        : 'https://pypi.org/simple',
      logPath: typeof deployRaw.logPath === 'string' ? deployRaw.logPath : '',
    },
  }
}

/**
 * Whether the context can still own new effects.
 *
 * Cordis clears `uid` on disposal and moves `state` to 5 on unload. A plugin
 * whose async work outlives its scope must stop before calling `effect`.
 *
 * @param {any} ctx - Cordis context.
 * @returns {boolean} True while the fiber is loadable.
 */
function fiberActive(ctx) {
  const fiber = ctx?.fiber
  return fiber === undefined || (fiber.uid !== null && fiber.state !== 5)
}

/**
 * Activate the infra half.
 * @param {any} ctx - Cordis context.
 * @param {any} rawConfig - Raw plugin configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger

  const overlay = createOverlay({ file: config.overlayFile, logger })
  const state = createStateStore({ file: config.stateFile, logger })
  const client = createMilocoClient({
    baseUrl: config.baseUrl || undefined,
    token: config.token || undefined,
    timeoutMs: config.timeoutMs,
    home: config.home,
    overlay,
  })

  ctx.inject(['sessionController', 'webServer', 'sandboxPolicy'], (host) => {
    /** @type {(() => void)[]} */
    const pushDisposers = []
    // 家庭助手专属工作区：插件自己创建目录，并注册成宿主工作区。
    // effect 必须同步注册，异步初始化才有一个可以依附的作用域。
    const home = createHomeService({ ctx: host, config, overlay, logger: host.logger })
    host.effect(() => {
      void home.ensure().then((state) => {
        if (!fiberActive(host)) return
        host.logger?.info?.(`dsh-miloco-bridge: 家庭助手工作区 ${state.path}`)
      }).catch((error) => {
        host.logger?.warn?.(`dsh-miloco-bridge: 初始化家庭助手工作区失败：${error instanceof Error ? error.message : error}`)
      })
      return () => {}
    }, 'dsh-miloco-bridge: home workspace')

    // Claim the cleanup effect before the dynamic import starts: the scope may
    // be disposed while the import is pending, and an effect registered
    // afterwards throws INACTIVE_EFFECT inside a detached promise.
    host.effect(() => () => {
      for (const dispose of pushDisposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error) {
          host.logger?.warn?.(`dsh-miloco-bridge: 卸载推送服务失败：${error instanceof Error ? error.message : error}`)
        }
      }
    }, 'dsh-miloco-bridge: push service')

    // 推送服务：Miloco → DSH 的入站通路。
    void import('./push.js').then(({ createPushService }) => {
      if (!fiberActive(host)) return
      const push = createPushService({
        ctx: host,
        config,
        logger: host.logger,
        overlay,
        state,
        home,
        agentPreset: config.push.target.agentPreset,
        activity: {
          last: async () => (await readSessions(state)).last,
          note: async sessionId => noteSession(state, sessionId),
          clear: async sessionIds => clearSessions(state, sessionIds),
        },
      })
      push.register()
      pushDisposers.push(push.dispose)
      host.logger?.info?.(`dsh-miloco-bridge: 推送目标覆盖文件 ${config.overlayFile}`)
    }).catch((error) => {
      host.logger?.warn?.(`dsh-miloco-bridge: 加载推送服务失败：${error instanceof Error ? error.message : error}`)
    })

    const deploy = createDeployService({ config, logger: host.logger, overlay })
    const uninstall = createUninstallService({ config, logger: host.logger, overlay })
    const writeConfig = config.profilePatch
      ? createProfileConfigWriter({ file: config.profilePatch })
      : undefined
    const disposeApi = registerSettingsApi({
      ctx: host,
      config,
      client,
      overlay,
      state,
      deploy,
      uninstall,
      writeConfig,
      home,
      logger: host.logger,
    })
    host.effect(() => disposeApi, 'dsh-miloco-bridge: settings api')
  })
}

export { createMilocoClient, createMilocoTools, createOverlay, registerSettingsApi, createDeployService, createUninstallService }
