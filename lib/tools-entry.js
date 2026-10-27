/**
 * dsh-miloco-bridge — tool half.
 *
 * Mounted **inside the `miloco` Agent preset**, never globally:
 *
 * 1. native DSH tools that wrap Miloco's HTTP API;
 * 2. the bundled, independently written Skill documents;
 * 3. `dsh_deliver_message` for model-initiated delivery.
 *
 * Because this module lives in a preset scope, a normal conversation sees no
 * `miloco_*` tool and receives no Miloco Skill. Only sessions created with
 * 「Miloco 家庭助手」 get them.
 *
 * The bundle imports no host packages. A third-party plugin resolves bare
 * specifiers against its own directory, so tool definitions are built against
 * the plain registry contract.
 *
 * @module dsh-miloco-bridge/tools
 */

import { createMilocoClient, resolveMilocoHome } from './miloco-client.js'
import { createMilocoTools } from './tools.js'
import { registerSkills } from './skills.js'
import { createDeliverTool } from './deliver-tool.js'
import { createOverlay, DEFAULT_OVERLAY_FILE } from './overlay.js'
import { normalizePerceptionLevel } from './perception.js'
import { DEFAULT_PUSH_PATH } from './push.js'
import { createStateStore, DEFAULT_STATE_FILE, noteSession, describeMode } from './state.js'

/** Cordis plugin name. */
export const name = 'dsh-miloco-bridge-tools'

/** Services the plugin consumes at activation. */
export const inject = ['tools']

/**
 * Normalise and validate the raw plugin configuration.
 *
 * @param {Record<string, any>} raw - Raw configuration from the loader.
 * @returns {any} The normalised configuration.
 */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const pushRaw = config.push && typeof config.push === 'object' ? config.push : {}
  const targetRaw = pushRaw.target && typeof pushRaw.target === 'object' ? pushRaw.target : {}
  const modelRaw = pushRaw.model && typeof pushRaw.model === 'object' ? pushRaw.model : {}

  const readOnly = config.readOnly !== false
  const timeoutMs = Number(config.timeoutMs)

  return {
    baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
    token: typeof config.token === 'string' ? config.token : '',
    home: typeof config.home === 'string' ? config.home : resolveMilocoHome(process.env.MILOCO_HOME),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
    readOnly,
    cwd: typeof config.cwd === 'string' ? config.cwd : '',
    overlayFile: typeof config.overlayFile === 'string' && config.overlayFile
      ? config.overlayFile
      : DEFAULT_OVERLAY_FILE,
    stateFile: typeof config.stateFile === 'string' && config.stateFile
      ? config.stateFile
      : DEFAULT_STATE_FILE,
    push: {
      enabled: pushRaw.enabled !== false,
      path: typeof pushRaw.path === 'string' && pushRaw.path.startsWith('/')
        ? pushRaw.path
        : DEFAULT_PUSH_PATH,
      token: typeof pushRaw.token === 'string' ? pushRaw.token : '',
      waitForResult: pushRaw.waitForResult !== false,
      target: {
        sessionId: typeof targetRaw.sessionId === 'string' ? targetRaw.sessionId.trim() : '',
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
  }
}

/**
 * Read the session id from a tool execution.
 * @param {any} exec - Tool execution context.
 * @returns {string} The session id, or an empty string.
 */
export function sessionIdOf(exec) {
  return exec?.agent?.session?.header?.id
    ?? exec?.agent?.session?.id
    ?? exec?.agent?.id
    ?? ''
}

/**
 * Activate the tool half.
 *
 * @param {any} ctx - Cordis context.
 * @param {any} rawConfig - Raw plugin configuration.
 */
export async function apply(ctx, rawConfig) {
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

  // Runtime mode: state file first (written by the Web tab), static config as
  // fallback. The two halves live in different scopes, hence the shared file.
  const persisted = await state.read().catch(() => ({}))
  const persistedMode = typeof persisted.mode === 'string'
    ? persisted.mode
    : (config.readOnly === false ? 'full' : 'readonly')
  // `chat` was removed; old state files fall back to read-only instead of
  // leaving the preset with no household tools at all.
  const mode = persistedMode === 'full' ? 'full' : 'readonly'
  const modeSpec = describeMode(mode)
  const readOnly = !modeSpec.writeTools

  /**
   * Read the live model catalog of this deployment.
   * @returns {Promise<any>} The catalog.
   */
  const catalog = async () => {
    try {
      const value = await ctx.sessionController.modelCatalog()
      return {
        providers: (value?.groups ?? []).map(group => ({
          id: group.id,
          name: group.name,
          models: (group.models ?? []).map(model => ({
            id: model.id,
            name: model.name,
            description: model.description,
            ...(model.reasoning ? { reasoning: model.reasoning } : {}),
          })),
        })),
        failures: value?.failures ?? [],
      }
    } catch (error) {
      return {
        providers: [],
        failures: [{ message: error instanceof Error ? error.message : String(error) }],
      }
    }
  }

  const tools = createMilocoTools({
    client,
    readOnly,
    overlay,
    catalog,
    state,
    sessionIdOf,
  })

  const disposers = tools.map(tool => ctx.tools.register(tool))
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        logger?.warn?.(`dsh-miloco-bridge: 卸载工具失败：${error instanceof Error ? error.message : error}`)
      }
    }
  }, 'dsh-miloco-bridge: tools')

  logger?.info?.(
    `dsh-miloco-bridge: 模式=${mode}（${modeSpec.label}），注册 ${tools.length} 个工具`,
  )

  // ------------------------------------------------------------------ 技能

  ctx.inject(['skills'], (host) => {
    void registerSkills(host, host.logger).then((skillDisposers) => {
      host.effect(() => () => {
        for (const dispose of skillDisposers) {
          try {
            dispose()
          } catch { /* 卸载期忽略 */ }
        }
      }, 'dsh-miloco-bridge: skills')
      host.logger?.info?.(`dsh-miloco-bridge: 已注册 ${skillDisposers.length} 个技能`)
    })
  })

  // ------------------------------------------------------------------ DSH 投递工具

  ctx.inject(['sessionController'], (host) => {
    const deliver = createDeliverTool({
      sessionController: host.sessionController,
      cwd: config.cwd || process.cwd(),
      onSession: sessionId => {
        void noteSession(state, sessionId).catch(() => {})
      },
    })
    const original = deliver.execute
    deliver.execute = async (args, exec) => {
      const sessionId = sessionIdOf(exec)
      if (sessionId) void noteSession(state, sessionId).catch(() => {})
      return original(args, exec)
    }
    const dispose = host.tools.register(deliver)
    host.effect(() => dispose, 'dsh-miloco-bridge: deliver tool')
  })
}

export { createMilocoClient, createMilocoTools, registerSkills }
