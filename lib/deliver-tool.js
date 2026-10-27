/**
 * DSH-side delivery tool.
 *
 * Lets the model itself deliver a piece of text into a DSH conversation, for
 * example "把这条告警发到家庭群会话". It reuses the same session controller
 * the Web GUI uses, so the message lands in a real conversation.
 *
 * Model semantics match the push target: an empty model means "keep the
 * conversation's own model"; a configured provider+model pins that
 * conversation to it.
 *
 * @module dsh-miloco-bridge/deliver-tool
 */

import { randomUUID } from 'node:crypto'

/**
 * Check whether an error means "session not found".
 * @param {unknown} error - Caught error.
 * @returns {boolean} Whether it is a not-found error.
 */
function isMissingSession(error) {
  const code = error && typeof error === 'object' ? error.code : undefined
  if (typeof code === 'string' && code.includes('not-found')) return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /not[- ]found|no such session/i.test(message)
}

/**
 * Build the `dsh_deliver_message` tool.
 *
 * @param {{sessionController: any, cwd?: string, agentPreset?: string, onSession?: (id: string) => void}} options - Delivery dependencies.
 * @returns {any} The tool definition.
 */
export function createDeliverTool(options) {
  const { sessionController } = options
  const cwd = options.cwd || process.cwd()
  const agentPreset = options.agentPreset || ''

  /**
   * Resolve a persisted session, creating it only when it does not exist.
   * @param {string} sessionId - Desired session id.
   * @returns {Promise<string>} The live session id.
   */
  async function ensureSession(sessionId) {
    let found
    try {
      found = await sessionController.resolveAgent(sessionId)
    } catch (error) {
      if (!isMissingSession(error)) throw error
      found = { error }
    }
    if (found && typeof found === 'object' && 'error' in found && found.error) {
      if (!isMissingSession(found.error)) throw found.error
      let created
      try {
        created = await sessionController.create({
          sessionId,
          cwd,
          ...(agentPreset ? { agentPreset } : {}),
        })
      } catch (error) {
        if (!agentPreset) throw error
        created = await sessionController.create({ sessionId, cwd })
      }
      return created?.sessionId ?? sessionId
    }
    return sessionId
  }

  return {
    name: 'dsh_deliver_message',
    description: '把一段文本投递到一个 DSH 会话（对话）。'
      + '可指定会话 id（留空则按 name 派生/复用一个会话），也可指定让哪个模型处理。'
      + '适合把告警、摘要、提醒送进某个已经在跑的对话里；它不会执行任何米家设备动作。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要投递的正文' },
        sessionId: { type: 'string', description: '目标会话 id；留空按 name 派生' },
        name: { type: 'string', description: '会话名（sessionId 留空时用于派生会话 id）' },
        provider: { type: 'string', description: '模型供应商 id；留空则跟随该会话当前模型' },
        model: { type: 'string', description: '模型 id；留空则跟随该会话当前模型' },
        reasoningEffort: { type: 'string', description: '推理强度（可选，仅在指定模型时生效）' },
      },
      required: ['text'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!text) throw new Error('缺少参数 text')

      const explicit = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const sessionId = explicit
        || `dsh-delivery-${(name || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)}`
      const liveSessionId = await ensureSession(sessionId)
      options.onSession?.(liveSessionId)

      const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
      const model = typeof args.model === 'string' ? args.model.trim() : ''
      if (Boolean(provider) !== Boolean(model)) {
        throw new Error('provider 与 model 必须同时提供，或同时留空')
      }
      if (provider && model) {
        const effort = typeof args.reasoningEffort === 'string' ? args.reasoningEffort.trim() : ''
        await sessionController.selectModel({
          sessionId: liveSessionId,
          provider,
          model,
          ...(effort ? { reasoningEffort: effort } : {}),
        })
      }

      await sessionController.prompt({
        requestId: randomUUID(),
        sessionId: liveSessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, exec?.signal ?? new AbortController().signal)

      return JSON.stringify({
        delivered: true,
        sessionId: liveSessionId,
        model: provider && model ? { provider, model } : 'session-default',
      }, null, 2)
    },
  }
}
