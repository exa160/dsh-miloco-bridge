/**
 * Native DSH tools for the Miloco household backend.
 *
 * Every tool is a thin, well-described wrapper over one backend endpoint.
 * The tool set is split into two groups:
 *
 * - **Read tools** are always registered. They observe the household
 *   (devices, cameras, perception events, rules, tasks, identities, memory,
 *   token usage) and never change physical state.
 * - **Write tools** are registered **only** when the plugin runs with
 *   `readOnly: false` (the default). While the plugin is read-only the model
 *   cannot even see them, which is the strongest guarantee that no device is
 *   touched without an explicit human decision.
 *
 * The tools are built by hand rather than through `defineTool` so the bundle
 * stays free of host-package imports (a third-party plugin resolves bare
 * specifiers against its own directory, not against the host).
 *
 * @module dsh-miloco-bridge/tools
 */

import { MilocoError } from './miloco-client.js'
import { PERCEPTION_LEVELS } from './perception.js'
import { noteSession } from './state.js'

/**
 * Serialise a canonical tool value as readable JSON text.
 * @param {unknown} value - Value to serialise.
 * @returns {string} Pretty-printed JSON.
 */
export function dump(value) {
  return JSON.stringify(value, null, 2) ?? 'null'
}

/**
 * Assert that a required string argument is present.
 * @param {Record<string, any>} args - Tool arguments.
 * @param {string} name - Argument name.
 * @returns {string} The trimmed value.
 */
function requireString(args, name) {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少参数 ${name}`)
  }
  return value.trim()
}

/**
 * Coerce a model-supplied value into the type a MIoT property expects.
 * @param {unknown} value - Raw value.
 * @returns {unknown} Coerced value.
 */
export function coerceValue(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  const lower = text.toLowerCase()
  if (['true', 'on', 'open', '1'].includes(lower)) return true
  if (['false', 'off', 'closed', '0'].includes(lower)) return false
  if (text !== '' && Number.isFinite(Number(text))) return Number(text)
  return value
}

/**
 * Build one registry-ready tool definition.
 * @param {{name: string, description: string, parameters?: Record<string, any>, required?: string[], run: (args: any, exec: any) => Promise<any>}} spec - Tool spec.
 * @returns {any} The tool definition.
 */
function defineMilocoTool(spec) {
  const properties = spec.parameters ?? {}
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties,
      ...(spec.required?.length ? { required: spec.required } : {}),
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : dump(value) }],
    },
    async execute(args, exec) {
      return dump(await spec.run(args ?? {}, exec))
    },
  }
}

/**
 * Build the full Miloco tool set.
 *
 * @param {{client: any, readOnly: boolean, logger?: {warn: (m: string) => void}}} options - Tool options.
 * @returns {any[]} The tool definitions to register.
 */
export function createMilocoTools(options) {
  const { client, readOnly } = options
  const call = (method, path, opts) => client.request(method, path, opts)

  /** @type {any[]} */
  const tools = []
  /** Read tool names, filled once every read tool has been pushed. */
  const readToolNames = []

  // ---------------------------------------------------------------- 概览 / 状态

  tools.push(defineMilocoTool({
    name: 'miloco_status',
    description: '查询 Miloco 运行状态：米家账号是否已绑定、感知引擎是否就绪、规则/数据库是否健康、摄像头数量上限。排查任何问题前先调用它。',
    async run(_args, exec) {
      const status = await call('GET', '/api/admin/status', { signal: exec?.signal })
      const engine = await call('GET', '/api/perception/engine/status', { signal: exec?.signal }).catch(() => null)
      return { status, perceptionEngine: engine }
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_capabilities',
    description: '列出本插件当前可用的能力与只读状态。只读模式下没有任何写操作工具，设备不会被触碰。',
    async run() {
      const { baseUrl, home } = await client.endpoint()
      return {
        readOnly,
        backend: { baseUrl, home },
        readTools: readToolNames,
        writeTools: readOnly ? [] : WRITE_TOOL_NAMES,
        note: readOnly
          ? '当前为只读模式：控制设备、触发场景、推送通知、创建规则/任务等写操作工具未注册，模型无法调用。'
          : '当前允许写操作：控制设备等会产生物理副作用，调用前请确认。',
      }
    },
  }))

  // ---------------------------------------------------------------- 设备

  tools.push(defineMilocoTool({
    name: 'miloco_device_list',
    description: '列出米家设备（did、名称、在线状态、所属房间、设备类型）。要控制某台设备前，先用本工具拿到 did。',
    parameters: {
      room: { type: 'string', description: '按房间名过滤（本地匹配 room_name），留空返回全部设备' },
    },
    async run(args, exec) {
      const devices = await call('GET', '/api/miot/device_list', { signal: exec?.signal })
      const room = typeof args.room === 'string' ? args.room.trim().toLowerCase() : ''
      if (!room || !Array.isArray(devices)) return devices
      return devices.filter((device) => String(device?.room_name ?? device?.room ?? '').toLowerCase().includes(room))
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_device_spec',
    description: '读取单台设备的 MIoT SPEC 定义（服务 siid / 属性 piid / 动作 aiid 与取值范围）。设置属性前必须先用本工具确认正确的 iid 字符串（形如 prop.2.1）。',
    parameters: {
      did: { type: 'string', description: '设备 did' },
    },
    required: ['did'],
    async run(args, exec) {
      const did = requireString(args, 'did')
      return call('GET', `/api/miot/devices/${encodeURIComponent(did)}/spec`, { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_device_status',
    description: '读取设备当前属性值（开关状态、设定温度、当前温湿度、PM2.5、电量等）。传 iid 读单个属性，不传则返回设备上报的全部状态。',
    parameters: {
      did: { type: 'string', description: '设备 did' },
      iid: { type: 'string', description: '属性 iid，例如 prop.2.1；留空返回全部状态' },
    },
    required: ['did'],
    async run(args, exec) {
      const did = requireString(args, 'did')
      return call('GET', `/api/miot/devices/${encodeURIComponent(did)}/status`, {
        query: args.iid ? { iid: args.iid } : undefined,
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_device_history',
    description: '读取最近被访问过的设备属性 iid 历史（后端 LRU 快照），用于回忆"上次读到的是哪个属性"。',
    async run(_args, exec) {
      return call('GET', '/api/miot/device_history', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_home_info',
    description: '一次抓取家庭总览：设备、区域（房间）、场景与成员信息。refresh=true 会强制向后端重新拉取（较慢）。',
    parameters: {
      refresh: { type: 'boolean', description: '是否强制刷新缓存' },
    },
    async run(args, exec) {
      return call('GET', '/api/miot/home', {
        query: args.refresh ? { refresh: true } : undefined,
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_camera_list',
    description: '列出米家账号下的摄像头设备（did、名称、在线状态、房间）。',
    async run(_args, exec) {
      return call('GET', '/api/miot/camera_list', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_user_info',
    description: '读取当前米家账号与家庭成员（user_id、昵称、角色）。',
    async run(_args, exec) {
      const user = await call('GET', '/api/miot/user_info', { signal: exec?.signal }).catch(() => null)
      const login = await call('GET', '/api/miot/login_status', { signal: exec?.signal }).catch(() => null)
      return { user, login }
    },
  }))

  // ---------------------------------------------------------------- 场景

  tools.push(defineMilocoTool({
    name: 'miloco_scene_list',
    description: '列出米家手动场景（回家 / 离家 / 睡眠等）的 scene_id 与名称。'
      + '注意：Miloco 后端没有独立的场景列表接口，场景从家庭总览里取。',
    async run(_args, exec) {
      const home = await call('GET', '/api/miot/home', { signal: exec?.signal })
      return {
        homeName: home?.home_name,
        scenes: Array.isArray(home?.scenes) ? home.scenes : [],
      }
    },
  }))

  // ---------------------------------------------------------------- 感知

  tools.push(defineMilocoTool({
    name: 'miloco_perceive',
    description: '用摄像头看画面、听现场声音，并用多模态大模型回答问题。sources 传摄像头 did 列表，query 用自然语言提问'
      + '（例如"客厅现在有人吗""刚才进门的人穿的什么衣服"）。只能回答画面/声音层面的问题；温度、电量一类数值要用 miloco_device_status。'
      + '需要该摄像头已开启感知。',
    parameters: {
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: '摄像头 did 列表',
      },
      query: { type: 'string', description: '自然语言问题' },
    },
    required: ['sources', 'query'],
    async run(args, exec) {
      const sources = Array.isArray(args.sources) ? args.sources.filter(s => typeof s === 'string' && s) : []
      if (sources.length === 0) throw new Error('缺少参数 sources：至少给一个摄像头 did')
      const query = requireString(args, 'query')
      return call('POST', '/api/perception/perceive', { body: { sources, query }, signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_perception_logs',
    description: '回顾近期感知事件（识别到有人/无人、动作、声音、离房等），用于回答"刚才发生了什么"。按时间倒序返回。',
    parameters: {
      limit: { type: 'integer', description: '返回条数，默认 20' },
      since: { type: 'string', description: '只看该时间之后的事件（ISO 8601）' },
    },
    async run(args, exec) {
      return call('GET', '/api/perception/logs', {
        query: { limit: args.limit ?? 20, since: args.since },
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_perception_devices',
    description: '列出当前开启感知（正在被观察）的摄像头及其设备名。',
    async run(_args, exec) {
      return call('GET', '/api/perception/devices', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_perception_scope',
    description: '查询感知范围：哪些家庭、哪些摄像头正在参与感知，每台摄像头的麦克风开关与"感知须知"自定义提示。',
    async run(_args, exec) {
      return call('GET', '/api/miot/scope/cameras', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_perception_engine_status',
    description: '查询感知引擎状态：是否运行、采集到哪些流、模型配置、错误信息。',
    async run(_args, exec) {
      return call('GET', '/api/perception/engine/status', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_event_list',
    description: '查询感知事件流（有效事件、含来源设备与时间戳），可按事件类型、来源设备、时间范围过滤。',
    parameters: {
      event_type: { type: 'string', description: '事件类型过滤' },
      source: { type: 'string', description: '来源过滤' },
      since: { type: 'integer', description: '起始时间戳（毫秒）' },
      until: { type: 'integer', description: '结束时间戳（毫秒）' },
      limit: { type: 'integer', description: '返回条数，默认 100' },
    },
    async run(args, exec) {
      return call('GET', '/api/events', {
        query: {
          event_type: args.event_type,
          source: args.source,
          since: args.since,
          until: args.until,
          limit: args.limit ?? 100,
        },
        signal: exec?.signal,
      })
    },
  }))

  // ---------------------------------------------------------------- 规则 / 任务

  tools.push(defineMilocoTool({
    name: 'miloco_rule_list',
    description: '列出米家自动化规则（条件 → 动作）。enabled_only=true 只看已启用的规则。',
    parameters: {
      enabled_only: { type: 'boolean', description: '只看已启用规则' },
      include_milestone: { type: 'boolean', description: '包含里程碑类规则' },
    },
    async run(args, exec) {
      return call('GET', '/api/rules', {
        query: {
          enabled_only: args.enabled_only ?? false,
          include_milestone: args.include_milestone ?? false,
        },
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_rule_logs',
    description: '读取规则触发日志（何时、被什么触发、是否成功），用于排查自动化为什么没生效。',
    parameters: {
      rule_id: { type: 'string', description: '只看某条规则；留空返回全部' },
    },
    async run(args, exec) {
      if (args.rule_id) {
        return call('GET', `/api/rules/${encodeURIComponent(args.rule_id)}/logs`, { signal: exec?.signal })
      }
      return call('GET', '/api/rules/logs', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_task_list',
    description: '列出长期任务（定时提醒、行为累积统计、限时任务等）。',
    async run(_args, exec) {
      return call('GET', '/api/tasks', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_task_summary',
    description: '读取长期任务的汇总视图（按状态/类型分组）。',
    async run(_args, exec) {
      return call('GET', '/api/tasks/summary', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_cron_list',
    description: '列出后端已注册的定时计划（APScheduler crons），含触发时间与归属的 task_id。',
    parameters: {
      task_id: { type: 'string', description: '按任务 id 过滤' },
      orphan: { type: 'boolean', description: '只看没有对应任务的孤儿计划' },
    },
    async run(args, exec) {
      return call('GET', '/api/crons', {
        query: { task_id: args.task_id, orphan: args.orphan ?? false },
        signal: exec?.signal,
      })
    },
  }))

  // ---------------------------------------------------------------- 身份 / 档案

  tools.push(defineMilocoTool({
    name: 'miloco_person_list',
    description: '列出已登记的家庭成员（识别出的身份、样本数量、房间等）。',
    async run(_args, exec) {
      return call('GET', '/api/identity/persons', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_pet_list',
    description: '列出已登记的宠物成员。',
    async run(_args, exec) {
      return call('GET', '/api/identity/pets', { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_home_profile',
    description: '读取家庭档案（每位成员/宠物的偏好、习惯、作息、身体状况、家庭规则等）。'
      + '回答"他喜欢什么""家里有什么规矩""谁不吃辣"这类问题时先查这里。target 可选 both/person/pet。',
    parameters: {
      target: { type: 'string', description: 'both（默认）/ person / pet' },
    },
    async run(args, exec) {
      const entries = await call('GET', '/api/home-profile/entries', {
        query: { target: args.target ?? 'both' },
        signal: exec?.signal,
      })
      const rendered = await call('GET', '/api/home-profile/rendered', { signal: exec?.signal }).catch(() => null)
      return { entries, rendered }
    },
  }))

  // ---------------------------------------------------------------- 观测

  tools.push(defineMilocoTool({
    name: 'miloco_token_usage',
    description: '查询大模型 token 用量与费用统计（感知引擎与 Agent 的开销），用于排查"是不是把额度烧在感知上了"。',
    parameters: {
      limit: { type: 'integer', description: '返回条数' },
      since: { type: 'integer', description: '起始时间戳（毫秒）' },
    },
    async run(args, exec) {
      return call('GET', '/api/admin/token-usage', {
        query: { limit: args.limit ?? 50, since: args.since },
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_action_list',
    description: '查询 Agent 动作台账（设备动作台账：谁、对哪台设备、做了什么、成功与否）。',
    parameters: {
      did: { type: 'string', description: '按设备过滤' },
      action_type: { type: 'string', description: '按动作类型过滤' },
      failed_only: { type: 'boolean', description: '只看失败的动作' },
      limit: { type: 'integer', description: '返回条数，默认 50' },
    },
    async run(args, exec) {
      return call('GET', '/api/actions', {
        query: {
          did: args.did,
          action_type: args.action_type,
          failed_only: args.failed_only,
          limit: args.limit ?? 50,
        },
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_agent_run_list',
    description: '查询 Agent 运行记录（每次 turn 的来源、耗时、是否成功、trace_id）。',
    parameters: {
      source: { type: 'string', description: '按来源过滤' },
      success: { type: 'boolean', description: '只看成功/失败的运行' },
      limit: { type: 'integer', description: '返回条数，默认 100' },
    },
    async run(args, exec) {
      return call('GET', '/api/agent_runs', {
        query: {
          source: args.source,
          success: args.success,
          limit: args.limit ?? 100,
        },
        signal: exec?.signal,
      })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_trace_get',
    description: '按 trace_id 读取一次 Agent 运行的完整轨迹（工具调用、耗时、错误）。',
    parameters: {
      trace_id: { type: 'string', description: 'trace id' },
    },
    required: ['trace_id'],
    async run(args, exec) {
      const traceId = requireString(args, 'trace_id')
      return call('GET', `/api/trace/${encodeURIComponent(traceId)}`, { signal: exec?.signal })
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_push_target',
    description: '查看 Miloco 主动推送当前的投递目标：投到哪个对话、触发哪个模型、感知等级、推送入口与令牌是否就绪。'
      + '用户问"推送会发到哪里 / 哪些感知事件会被过滤"时用这个。',
    async run() {
      const overlay = options.overlay ? await options.overlay.current() : null
      const current = overlay
        ? {
          target: overlay.push?.target ?? { sessionId: '' },
          model: overlay.push?.model ?? { provider: '', model: '', reasoningEffort: '' },
          perception: overlay.push?.perception ?? { minLevel: 'all' },
        }
        : null
      return {
        overlayFile: options.overlay?.file ?? null,
        current,
        note: '会话留空 = 投到「上一次触发 miloco 的会话」；'
          + '模型留空 = 跟随目标对话自己选的模型；'
          + '感知等级低于阈值的事件不会投递，规则/任务/对话事件不受影响。',
      }
    },
  }))

  tools.push(defineMilocoTool({
    name: 'miloco_push_models',
    description: '列出 DSH 当前可用的模型（按 provider 分组）。'
      + '设置 Miloco 推送要用哪个模型时，先调它拿准确的 provider/model id；'
      + '不要写死模型名，也不存在「DSH 默认模型」这个可选项。',
    async run() {
      const catalog = await options.catalog?.()
      if (!catalog) {
        return {
          providers: [],
          failures: [],
          note: '当前部署没有暴露模型目录服务',
        }
      }
      return catalog
    },
  }))

  if (readOnly) {
    for (const tool of tools) readToolNames.push(tool.name)
    return trackSessions(tools, options.state, options.sessionIdOf)
  }

  // ---------------------------------------------------------------- 写操作（仅非只读模式）

  const writeTools = []

  const ruleActionSchema = {
    type: 'object',
    properties: {
      did: { type: 'string', description: '设备 did；触发场景时填 scene_id' },
      iid: { type: 'string', description: 'prop.{siid}.{piid} / action.{siid}.{aiid} / scene' },
      value: { description: '属性目标值（iid 为 prop.* 时使用）' },
      params: { type: 'array', items: { type: 'string' }, description: '动作参数（iid 为 action.* 时使用）' },
      idempotent: { type: 'boolean', description: '默认 true；false 时必须提供 cooldown_minutes' },
      cooldown_minutes: { type: 'integer', minimum: 0, description: '非幂等动作的去重冷却时间（分钟）' },
    },
    required: ['did', 'iid'],
    additionalProperties: false,
  }

  writeTools.push(defineMilocoTool({
    name: 'miloco_device_control',
    description: '控制米家设备：设置属性（开关、调温、调亮度、开合窗帘）或调用动作。'
      + '必须先调用 miloco_device_spec 确认正确的 iid（形如 prop.2.1）与取值范围。'
      + '涉及门锁、燃气、摄像头开关等有物理风险的操作，请先向用户确认再执行。',
    parameters: {
      did: { type: 'string', description: '设备 did' },
      iid: { type: 'string', description: '属性 iid（set_property）或动作 iid（call_action）' },
      value: { type: 'string', description: '目标值；字符串会按属性类型转成布尔/数字' },
      type: {
        type: 'string',
        enum: ['set_property', 'set_properties', 'call_action'],
        description: '控制类型：set_property（默认）/ set_properties / call_action',
      },
      properties: {
        type: 'array',
        description: '一次设置多个属性时使用',
        items: {
          type: 'object',
          properties: {
            iid: { type: 'string', description: '属性 iid' },
            value: { type: 'string', description: '目标值' },
          },
          required: ['iid', 'value'],
          additionalProperties: false,
        },
      },
      params: {
        type: 'array',
        description: 'call_action 的输入参数列表',
        items: { type: 'string' },
      },
    },
    required: ['did'],
    async run(args, exec) {
      const did = requireString(args, 'did')
      const type = args.type ?? 'set_property'
      if (!['set_property', 'set_properties', 'call_action'].includes(type)) {
        throw new Error('type 只能是 set_property / set_properties / call_action')
      }
      const body = { type }
      if (type === 'set_properties') {
        if (!Array.isArray(args.properties) || args.properties.length === 0) {
          throw new Error('set_properties 需要 properties 数组')
        }
        body.properties = args.properties.map(p => ({ iid: String(p.iid), value: coerceValue(p.value) }))
      } else {
        body.iid = requireString(args, 'iid')
        if (type === 'call_action') {
          if (Array.isArray(args.params)) body.params = args.params
        } else {
          body.value = coerceValue(args.value)
        }
      }
      return call('POST', `/api/miot/devices/${encodeURIComponent(did)}/control`, { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_scene_trigger',
    description: '触发一个米家手动场景（回家 / 离家 / 睡眠等）。会同时执行该场景绑定的多个设备动作。',
    parameters: {
      scene_id: { type: 'string', description: '场景 id' },
    },
    required: ['scene_id'],
    async run(args, exec) {
      const sceneId = requireString(args, 'scene_id')
      return call('POST', `/api/miot/scenes/${encodeURIComponent(sceneId)}/trigger`, { signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_notify_push',
    description: '向米家 App 推送一条通知（主动告知家人：告警、提醒、播报）。',
    parameters: {
      notify: { type: 'string', description: '通知正文' },
    },
    required: ['notify'],
    async run(args, exec) {
      const notify = requireString(args, 'notify')
      return call('POST', '/api/miot/send_notify', { body: { notify }, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_rule_create',
    description: '创建一条结构化自动化规则。condition 指定感知设备与自然语言条件；'
      + 'event 模式用 actions（设备直控）或 action_descriptions（Agent 回调），'
      + 'state 模式用 on_enter_* / on_exit_*。task_id 必须是已存在的长期任务。',
    parameters: {
      name: { type: 'string', description: '规则名称' },
      task_id: { type: 'string', description: '关联的任务 id（snake_case，需先创建）' },
      condition: {
        type: 'object',
        description: '触发条件：感知设备列表（OR 语义）+ 自然语言描述',
        properties: {
          perceive_device_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '参与判断的感知设备 did 列表',
          },
          query: { type: 'string', description: '要识别的自然语言条件' },
        },
        required: ['perceive_device_ids', 'query'],
        additionalProperties: false,
      },
      mode: { type: 'string', enum: ['event', 'state'], description: 'event（默认）/ state' },
      direction: {
        type: 'string',
        enum: ['enter', 'exit', 'session', 'milestone', 'guard'],
        description: '可选；提供后优先于 mode，用于表达 exit/session/milestone/guard 语义',
      },
      lifecycle: { type: 'string', enum: ['permanent', 'temporary'], description: '默认 permanent' },
      enabled: { type: 'boolean', description: '是否启用，默认 true' },
      actions: {
        type: 'array',
        items: ruleActionSchema,
        description: 'event 模式的设备直控动作',
      },
      action_descriptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'event 模式下投递给 Agent 的回调提示文本',
      },
      on_enter_actions: {
        type: 'array',
        items: ruleActionSchema,
        description: 'state 模式进入时的设备直控动作',
      },
      on_enter_desc: { type: 'string', description: 'state 模式进入时投递给 Agent 的文本' },
      on_exit_actions: {
        type: 'array',
        items: ruleActionSchema,
        description: 'state 模式退出时的设备直控动作',
      },
      on_exit_desc: { type: 'string', description: 'state 模式退出时投递给 Agent 的文本' },
      on_target_desc: { type: 'string', description: 'duration record 达标瞬间投递的文本' },
      terminate_when: { type: 'string', description: 'lifecycle=temporary 时的自然语言终止条件' },
      exit_debounce_seconds: { type: 'integer', minimum: 0, description: 'state 模式退出防抖秒数' },
      duration_seconds: { type: 'integer', minimum: 1, description: '累计统计窗口（秒）' },
      duration_ratio: { type: 'number', exclusiveMinimum: 0, maximum: 1, description: '窗口内 True 比例阈值' },
    },
    required: ['name', 'task_id', 'condition'],
    async run(args, exec) {
      const name = requireString(args, 'name')
      const taskId = requireString(args, 'task_id')
      if (!/^[a-z0-9_]{1,32}$/.test(taskId)) {
        throw new Error('task_id 必须匹配 [a-z0-9_]{1,32}（只能用小写字母、数字、下划线）')
      }
      const condition = args.condition
      if (!condition || typeof condition !== 'object') throw new Error('缺少参数 condition')
      const deviceIds = Array.isArray(condition.perceive_device_ids)
        ? condition.perceive_device_ids.filter(id => typeof id === 'string' && id)
        : []
      const query = typeof condition.query === 'string' ? condition.query.trim() : ''
      if (deviceIds.length === 0) throw new Error('condition.perceive_device_ids 至少需要一个设备 did')
      if (!query) throw new Error('condition.query 不能为空')

      const modes = ['event', 'state']
      const directions = ['enter', 'exit', 'session', 'milestone', 'guard']
      if (args.direction && !directions.includes(args.direction)) {
        throw new Error(`direction 只能是 ${directions.join(' / ')}`)
      }
      if (args.mode && !modes.includes(args.mode)) {
        throw new Error(`mode 只能是 ${modes.join(' / ')}`)
      }
      if (args.direction && args.mode) {
        const expected = args.direction === 'session' ? 'state' : 'event'
        if (args.mode !== expected) throw new Error(`direction=${args.direction} 对应 mode=${expected}`)
      }

      const body = { name, task_id: taskId, condition: { perceive_device_ids: deviceIds, query } }
      if (args.direction) body.direction = args.direction
      else body.mode = args.mode ?? 'event'
      if (args.lifecycle) body.lifecycle = args.lifecycle
      if (args.enabled !== undefined) body.enabled = Boolean(args.enabled)
      for (const key of ['actions', 'action_descriptions', 'on_enter_actions', 'on_exit_actions']) {
        if (args[key] !== undefined) {
          if (!Array.isArray(args[key])) throw new Error(`${key} 必须是数组`)
          body[key] = args[key]
        }
      }
      for (const key of ['on_enter_desc', 'on_exit_desc', 'on_target_desc', 'terminate_when']) {
        if (args[key] !== undefined) body[key] = args[key]
      }
      for (const key of ['exit_debounce_seconds', 'duration_seconds', 'duration_ratio']) {
        if (args[key] !== undefined) body[key] = args[key]
      }
      return call('POST', '/api/rules', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_rule_delete',
    description: '删除一条自动化规则。先用 miloco_rule_list 确认 rule_id；删除后不可恢复。',
    parameters: {
      rule_id: { type: 'string', description: '规则 id' },
    },
    required: ['rule_id'],
    async run(args, exec) {
      const ruleId = requireString(args, 'rule_id')
      return call('DELETE', `/api/rules/${encodeURIComponent(ruleId)}`, { signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_task_create',
    description: '创建一个长期任务的占位行（POST /api/tasks）。'
      + '任务本身只保存 task_id 与描述；定时提醒再用 miloco_cron_create 关联，'
      + '条件规则用 miloco_rule_create 关联，累计统计用 miloco_task_record_init 初始化。',
    parameters: {
      task_id: {
        type: 'string',
        pattern: '^[a-z0-9_]{1,32}$',
        description: '任务 id，只能用小写字母、数字、下划线，最长 32 位',
      },
      description: {
        type: 'string',
        maxLength: 200,
        description: '任务描述，最多 200 字',
      },
      lifecycle: {
        type: 'string',
        enum: ['permanent', 'temporary'],
        description: 'permanent（默认）/ temporary',
      },
      expires_at: {
        type: 'string',
        description: '到期时刻，ISO 8601 且带时区；仅 lifecycle=temporary',
      },
    },
    required: ['task_id', 'description'],
    async run(args, exec) {
      const taskId = requireString(args, 'task_id')
      if (!/^[a-z0-9_]{1,32}$/.test(taskId)) {
        throw new Error('task_id 必须匹配 [a-z0-9_]{1,32}（只能用小写字母、数字、下划线）')
      }
      const description = requireString(args, 'description')
      if (Array.from(description).length > 200) throw new Error('description 不能超过 200 字')
      const body = { task_id: taskId, description }
      if (args.lifecycle !== undefined) {
        if (!['permanent', 'temporary'].includes(args.lifecycle)) {
          throw new Error('lifecycle 只能是 permanent / temporary')
        }
        body.lifecycle = args.lifecycle
      }
      if (args.expires_at !== undefined) {
        if (body.lifecycle !== 'temporary') throw new Error('expires_at 只能配 lifecycle=temporary')
        body.expires_at = requireString(args, 'expires_at')
      }
      return call('POST', '/api/tasks', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_task_record_init',
    description: '给已存在的长期任务初始化一份活跃记录（POST /api/tasks/{id}/record）。'
      + 'kind=progress 需 target/unit/window；kind=duration 可给 target_minutes；kind=event 不需要额外字段。',
    parameters: {
      task_id: { type: 'string', description: '任务 id（snake_case，需先创建）' },
      kind: { type: 'string', enum: ['progress', 'duration', 'event'], description: '记录类型' },
      content: {
        type: 'object',
        description: '按 kind 提供的记录参数',
        properties: {
          target: { type: 'integer', minimum: 1, description: 'progress：目标次数' },
          unit: { type: 'string', description: 'progress：计数单位，例如 次 / 杯' },
          window: {
            type: 'string',
            enum: ['day', 'week', 'month', 'longterm'],
            description: 'progress：统计窗口',
          },
          target_minutes: { type: 'integer', minimum: 1, description: 'duration：每日目标分钟数' },
          recurring_pattern: { type: 'object', additionalProperties: true, description: '可选重复规则' },
          expires_at: { type: 'string', description: '可选到期时刻（ISO 8601）' },
        },
        additionalProperties: false,
      },
    },
    required: ['task_id', 'kind'],
    async run(args, exec) {
      const taskId = requireString(args, 'task_id')
      if (!/^[a-z0-9_]{1,32}$/.test(taskId)) {
        throw new Error('task_id 必须匹配 [a-z0-9_]{1,32}（只能用小写字母、数字、下划线）')
      }
      const kind = requireString(args, 'kind')
      if (!['progress', 'duration', 'event'].includes(kind)) {
        throw new Error('kind 只能是 progress / duration / event')
      }
      const content = args.content && typeof args.content === 'object' ? args.content : {}
      if (kind === 'progress') {
        if (!Number.isInteger(content.target) || content.target <= 0) {
          throw new Error('progress 需要正整数 content.target')
        }
        if (!content.unit) throw new Error('progress 需要 content.unit')
        if (!['day', 'week', 'month', 'longterm'].includes(content.window)) {
          throw new Error('progress 需要 content.window：day / week / month / longterm')
        }
      }
      if (kind === 'duration' && content.target_minutes !== undefined) {
        if (!Number.isInteger(content.target_minutes) || content.target_minutes <= 0) {
          throw new Error('content.target_minutes 必须是正整数')
        }
      }
      return call('POST', `/api/tasks/${encodeURIComponent(taskId)}/record`, {
        body: { kind, content },
        signal: exec?.signal,
      })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_task_delete',
    description: '终止并删除一个长期任务及其关联的规则/定时计划/统计记录。'
      + 'reason=completed/expired/abandoned；用户主动取消时必须先二次确认。',
    parameters: {
      task_id: { type: 'string', description: '任务 id' },
      reason: { type: 'string', enum: ['completed', 'expired', 'abandoned'], description: 'completed / expired / abandoned' },
    },
    required: ['task_id', 'reason'],
    async run(args, exec) {
      const taskId = requireString(args, 'task_id')
      const reason = requireString(args, 'reason')
      if (!['completed', 'expired', 'abandoned'].includes(reason)) {
        throw new Error('reason 只能是 completed / expired / abandoned')
      }
      return call('DELETE', `/api/tasks/${encodeURIComponent(taskId)}`, {
        query: { reason },
        signal: exec?.signal,
      })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_cron_create',
    description: '在后端注册一个定时计划（cron 表达式 / 指定时刻 / 固定间隔），到点后由 Miloco 主动把事件投递给 DSH。',
    parameters: {
      name: { type: 'string', description: '计划名称' },
      kind: { type: 'string', enum: ['cron', 'at', 'every'], description: 'cron / at / every' },
      cron_expr: { type: 'string', description: 'cron 表达式，如 "0 22 * * *"' },
      at_iso: { type: 'string', description: 'ISO 8601 时刻（kind=at）' },
      every_ms: { type: 'integer', minimum: 60000, description: '间隔毫秒，最小 60000（kind=every）' },
      tz: { type: 'string', description: '时区，如 Asia/Shanghai' },
      message: { type: 'string', description: '到点后投递给 Agent 的文本' },
      task_id: { type: 'string', description: '关联的长期任务 id' },
    },
    required: ['kind', 'message'],
    async run(args, exec) {
      const kind = requireString(args, 'kind')
      if (!['cron', 'at', 'every'].includes(kind)) throw new Error('kind 只能是 cron / at / every')
      if (kind === 'cron' && !args.cron_expr) throw new Error('kind=cron 需要 cron_expr')
      if (kind === 'at' && !args.at_iso) throw new Error('kind=at 需要 at_iso')
      if (kind === 'every' && !args.every_ms) throw new Error('kind=every 需要 every_ms')
      const body = {
        kind,
        message: requireString(args, 'message'),
        name: args.name ?? 'miloco-cron',
        cron_expr: args.cron_expr,
        at_iso: args.at_iso,
        every_ms: args.every_ms,
        tz: args.tz,
        task_id: args.task_id,
      }
      return call('POST', '/api/crons', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_cron_delete',
    description: '删除一个定时计划（POST /api/crons 创建的 cron/at/every）。先用 miloco_cron_list 确认 cron_id。',
    parameters: {
      cron_id: { type: 'string', description: '定时计划 id' },
    },
    required: ['cron_id'],
    async run(args, exec) {
      const cronId = requireString(args, 'cron_id')
      return call('DELETE', `/api/crons/${encodeURIComponent(cronId)}`, { signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_scope_set',
    description: '设置参与感知的摄像头（in_use=true 开始观察，false 停止观察）。这是隐私相关操作，改动前请向用户确认。',
    parameters: {
      items: {
        type: 'array',
        description: '摄像头列表',
        items: {
          type: 'object',
          properties: {
            did: { type: 'string', description: '摄像头 did' },
            in_use: { type: 'boolean', description: '是否参与感知' },
          },
          required: ['did', 'in_use'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    async run(args, exec) {
      const items = Array.isArray(args.items) ? args.items : []
      if (items.length === 0) throw new Error('缺少参数 items')
      return call('PUT', '/api/miot/scope/cameras', {
        body: { items: items.map(i => ({ did: String(i.did), in_use: Boolean(i.in_use) })) },
        signal: exec?.signal,
      })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_home_profile_write',
    description: '写入家庭档案正式区（profile:write）。ops 支持 add/merge/replace/update/delete，'
      + '带 from=<candidate_id> 时后端会自动消费掉该候选条目。'
      + '这是记忆写入，不会碰任何设备。',
    parameters: {
      ops: {
        type: 'array',
        description: '操作列表',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'merge', 'replace', 'update', 'delete'],
              description: 'add / merge / replace / update / delete',
            },
            id: { type: 'string', description: '正式区条目 id（merge/replace/update/delete 用）' },
            from: { type: 'string', description: '候选条目 id（带上即消费该候选）' },
            entry: {
              type: 'object',
              description: '条目内容',
              properties: {
                type: {
                  type: 'string',
                  enum: [
                    'member_persona', 'member_health', 'member_routine', 'member_entertain',
                    'member_preference', 'family', 'space', 'device',
                  ],
                  description: '成员/家庭/空间/设备档案类型',
                },
                subject_id: { type: 'string', description: '成员 person_id' },
                subject_name: { type: 'string', description: '主体名称（成员称谓 / 空间名）' },
                content: { type: 'string', description: '条目正文' },
                confidence: { type: 'number', minimum: 0, maximum: 1, description: '置信度 0~1' },
                source: { type: 'string', enum: ['observed', 'user_told'], description: 'observed / user_told' },
                evidence_log: { type: 'array', items: { type: 'string' }, description: '证据' },
              },
              required: ['type', 'content'],
              additionalProperties: true,
            },
          },
          required: ['op'],
          additionalProperties: true,
        },
      },
      user_edit: {
        type: 'boolean',
        description: '用户直接告知的内容设为 true（后端会按 user_told / 高置信度处理）',
      },
    },
    required: ['ops'],
    async run(args, exec) {
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('缺少参数 ops')
      const body = { ops }
      if (args.user_edit !== undefined) body.user_edit = Boolean(args.user_edit)
      return call('POST', '/api/home-profile/profile:write', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_home_profile_candidate_write',
    description: '写入家庭档案候选区（candidates:write），用于记录一次新的观察，等待证据攒够后再提升。',
    parameters: {
      ops: {
        type: 'array',
        description: '操作列表',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['add', 'merge', 'update', 'delete'],
              description: 'add / merge / update / delete',
            },
            id: { type: 'string', description: '候选条目 id' },
            date: { type: 'string', description: '观察日期（YYYY-MM-DD）' },
            entry: {
              type: 'object',
              description: '条目内容',
              properties: {
                type: {
                  type: 'string',
                  enum: [
                    'member_persona', 'member_health', 'member_routine', 'member_entertain',
                    'member_preference', 'family', 'space', 'device',
                  ],
                  description: '成员/家庭/空间/设备档案类型',
                },
                subject_id: { type: 'string', description: '成员 person_id' },
                subject_name: { type: 'string', description: '主体名称' },
                content: { type: 'string', description: '条目正文' },
                confidence: { type: 'number', minimum: 0, maximum: 1, description: '置信度 0~1' },
                source: { type: 'string', enum: ['observed', 'user_told'], description: 'observed / user_told' },
                evidence_log: { type: 'array', items: { type: 'string' }, description: '证据' },
              },
              required: ['type', 'content'],
              additionalProperties: true,
            },
          },
          required: ['op', 'date'],
          additionalProperties: true,
        },
      },
    },
    required: ['ops'],
    async run(args, exec) {
      const ops = Array.isArray(args.ops) ? args.ops : []
      if (ops.length === 0) throw new Error('缺少参数 ops')
      if (ops.some(op => !op || typeof op.date !== 'string' || !op.date.trim())) {
        throw new Error('candidates:write 的每个 op 都必须带 date（YYYY-MM-DD）')
      }
      return call('POST', '/api/home-profile/candidates:write', { body: { ops }, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_home_profile_commit',
    description: '提交家庭档案：后端会自动做过期候选清理（30 天且证据不足 3 条）、token 预算归档与 markdown 渲染持久化。',
    async run(_args, exec) {
      return call('POST', '/api/home-profile/commit', { signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_home_profile_reassign',
    description: '统一家庭档案的主体归属：把"爸爸/父亲/老王"归并到同一个 person_id，'
      + '或把"客厅/大厅/起居室"收敛成同一个规范空间名。一次操作会同时改写正式区与候选区。',
    parameters: {
      mappings: {
        type: 'array',
        description: '归并映射',
        items: {
          type: 'object',
          properties: {
            from_subject_ids: { type: 'array', items: { type: 'string' }, description: '要归并的旧 person_id' },
            from_subject_names: { type: 'array', items: { type: 'string' }, description: '要归并的旧名称' },
            to_subject_id: { type: 'string', description: '目标 person_id（非成员归并时留空）' },
            to_subject_name: { type: 'string', description: '目标规范名' },
          },
          required: ['to_subject_name'],
          additionalProperties: true,
        },
      },
    },
    required: ['mappings'],
    async run(args, exec) {
      const mappings = Array.isArray(args.mappings) ? args.mappings : []
      if (mappings.length === 0) throw new Error('缺少参数 mappings')
      return call('POST', '/api/home-profile/subject:reassign', { body: { mappings }, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_person_create',
    description: '新增一个家庭成员（只建花名册，不录样本）。样本登记走 miloco_miot_identity_register 那套流程。',
    parameters: {
      name: { type: 'string', description: '姓名' },
      role: { type: 'string', description: '家庭角色，如 爸爸 / 妈妈 / 奶奶' },
    },
    required: ['name'],
    async run(args, exec) {
      const body = { name: requireString(args, 'name') }
      if (args.role) body.role = args.role
      return call('POST', '/api/identity/persons', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_person_update',
    description: '修改家庭成员的姓名或家庭角色。',
    parameters: {
      person_id: { type: 'string', description: '成员 id' },
      name: { type: 'string', description: '新姓名' },
      role: { type: 'string', description: '新家庭角色' },
    },
    required: ['person_id'],
    async run(args, exec) {
      const personId = requireString(args, 'person_id')
      const body = {}
      if (args.name !== undefined) body.name = args.name
      if (args.role !== undefined) body.role = args.role
      return call('PUT', `/api/identity/persons/${encodeURIComponent(personId)}`, { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_person_delete',
    description: '删除一个家庭成员及其全部样本。执行前务必向用户二次确认。',
    parameters: {
      person_id: { type: 'string', description: '成员 id' },
    },
    required: ['person_id'],
    async run(args, exec) {
      const personId = requireString(args, 'person_id')
      return call('DELETE', `/api/identity/persons/${encodeURIComponent(personId)}`, { signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_pet_create',
    description: '新增一个宠物成员（只建花名册）。外观描述与识别参照走 miloco_pet_observe / miloco_pet_reference_crops。',
    parameters: {
      name: { type: 'string', description: '宠物名字' },
      species: { type: 'string', description: '物种，如 cat / dog' },
    },
    required: ['name'],
    async run(args, exec) {
      const body = { name: requireString(args, 'name') }
      if (args.species) body.species = args.species
      return call('POST', '/api/identity/pets', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_pet_update',
    description: '修改宠物成员的姓名或物种。',
    parameters: {
      pet_id: { type: 'string', description: '宠物 id' },
      name: { type: 'string', description: '新名字' },
      species: { type: 'string', description: '新物种' },
    },
    required: ['pet_id'],
    async run(args, exec) {
      const petId = requireString(args, 'pet_id')
      const body = {}
      if (args.name !== undefined) body.name = args.name
      if (args.species !== undefined) body.species = args.species
      return call('PATCH', `/api/identity/pets/${encodeURIComponent(petId)}`, { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_pet_delete',
    description: '删除一个宠物成员。执行前务必向用户二次确认。',
    parameters: {
      pet_id: { type: 'string', description: '宠物 id' },
    },
    required: ['pet_id'],
    async run(args, exec) {
      const petId = requireString(args, 'pet_id')
      return call('DELETE', `/api/identity/pets/${encodeURIComponent(petId)}`, { signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_pet_observe',
    description: '上传宠物图片（1~3 张）或单个视频，让多模态模型一次性生成共性外观描述。'
      + '**只观察不落库**——结果要先给用户确认，再用 miloco_pet_reference_crops 落库。'
      + '传本地文件绝对路径。',
    parameters: {
      files: {
        type: 'array',
        description: '本地图片/视频文件路径（1~3 张图，或 1 个视频，不能混传）',
        items: { type: 'string' },
      },
      grounding: { type: 'boolean', description: '是否做头部 grounding' },
    },
    required: ['files'],
    async run(args, exec) {
      const paths = Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string' && f) : []
      if (paths.length === 0) throw new Error('缺少参数 files')
      const fields = {}
      if (args.grounding !== undefined) fields.grounding = String(args.grounding)
      return client.postMultipart('/api/identity/pets:observe', {
        files: paths.map(p => ({ field: paths.length === 1 ? 'media' : 'medias', path: p })),
        fields,
        signal: exec?.signal,
      })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_register_preview',
    description: '身份样本登记的预览步骤：把用户提供的图片/视频（base64）送去做候选样本分析，'
      + '返回可用于登记的候选索引与置信度。只分析不落库。',
    parameters: {
      media_b64: { type: 'string', description: '单张图片/视频的 base64' },
      media_kind: { type: 'string', description: 'image / video' },
      media_b64_list: { type: 'array', items: { type: 'string' }, description: '多张图片的 base64 列表' },
      cluster_id: { type: 'string', description: '从陌生人池聚类建档时传 cluster_id' },
      member_id: { type: 'string', description: '已有成员 id（给该成员补样本）' },
      topk: { type: 'integer', description: '返回候选个数' },
    },
    async run(args, exec) {
      const body = {}
      for (const key of ['media_b64', 'media_kind', 'cluster_id', 'member_id']) {
        if (args[key] !== undefined) body[key] = args[key]
      }
      if (Array.isArray(args.media_b64_list)) body.media_b64_list = args.media_b64_list
      if (args.topk !== undefined) body.topk = args.topk
      return call('POST', '/api/identity/register/preview', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_register_commit',
    description: '身份样本登记的落库步骤：把预览选中的候选样本正式登记给某位成员。',
    parameters: {
      register_session_id_pending: { type: 'string', description: '预览返回的登记会话 id' },
      indices: { type: 'array', items: { type: 'integer' }, description: '选中的候选索引' },
      member_name: { type: 'string', description: '成员姓名（首次登记时用）' },
      member_role: { type: 'string', description: '家庭角色（首次登记时用）' },
    },
    required: ['register_session_id_pending'],
    async run(args, exec) {
      const body = { register_session_id_pending: requireString(args, 'register_session_id_pending') }
      if (Array.isArray(args.indices)) body.indices = args.indices
      if (args.member_name !== undefined) body.member_name = args.member_name
      if (args.member_role !== undefined) body.member_role = args.member_role
      return call('POST', '/api/identity/register/commit', { body, signal: exec?.signal })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_pet_reference_crops',
    description: '把宠物识别参照图落库（multipart 上传本地图片）。通常是 miloco_pet_observe 的第二步。',
    parameters: {
      pet_id: { type: 'string', description: '宠物 id' },
      files: {
        type: 'array',
        description: '本地图片路径列表',
        items: { type: 'string' },
      },
      mode: {
        type: 'string',
        enum: ['replace', 'append'],
        description: 'replace（整组替换，默认）/ append（按质量分保留 top-3）',
      },
    },
    required: ['pet_id', 'files'],
    async run(args, exec) {
      const petId = requireString(args, 'pet_id')
      const paths = Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string' && f) : []
      if (paths.length === 0) throw new Error('缺少参数 files')
      const fields = {}
      if (args.mode !== undefined) fields.mode = args.mode
      return client.postMultipart(`/api/identity/pets/${encodeURIComponent(petId)}/reference-crops`, {
        files: paths.map(p => ({ field: 'crops', path: p })),
        fields,
        signal: exec?.signal,
      })
    },
  }))

  writeTools.push(defineMilocoTool({
    name: 'miloco_push_target_set',
    description: '修改 Miloco 主动推送的投递目标。sessionId 留空 = 投到「上一次触发 miloco 的会话」；'
      + 'provider+model 留空 = 跟随那个对话自己选的模型；perceptionLevel 控制感知事件的最低优先级。',
    parameters: {
      sessionId: { type: 'string', description: '目标对话的会话 id；留空 = 上一次触发 miloco 的会话' },
      provider: { type: 'string', description: '模型供应商 id；留空 = 跟随该对话自己选的模型' },
      model: { type: 'string', description: '模型 id；留空 = 跟随该对话自己选的模型' },
      reasoningEffort: { type: 'string', description: '推理强度（可选）' },
      perceptionLevel: {
        type: 'string',
        description: `感知等级：${PERCEPTION_LEVELS.join(' / ')}；低于该等级的感知建议不投递`,
      },
    },
    async run(args) {
      if (!options.overlay) throw new Error('插件未启用覆盖文件，无法修改推送目标')
      const current = await options.overlay.current()
      const provider = typeof args.provider === 'string' ? args.provider.trim() : current.push.model.provider
      const model = typeof args.model === 'string' ? args.model.trim() : current.push.model.model
      if (Boolean(provider) !== Boolean(model)) {
        throw new Error('provider 与 model 必须同时填写，或同时留空（留空 = 跟随对话）')
      }
      const perceptionLevel = typeof args.perceptionLevel === 'string'
        ? args.perceptionLevel.trim()
        : ''
      if (perceptionLevel && !PERCEPTION_LEVELS.includes(perceptionLevel)) {
        throw new Error(`perceptionLevel 只能是 ${PERCEPTION_LEVELS.join(' / ')}`)
      }
      const next = {
        connection: current.connection,
        push: {
          token: current.push.token,
          target: {
            sessionId: typeof args.sessionId === 'string'
              ? args.sessionId.trim()
              : current.push.target.sessionId,
          },
          model: {
            provider,
            model,
            reasoningEffort: typeof args.reasoningEffort === 'string'
              ? args.reasoningEffort.trim()
              : current.push.model.reasoningEffort,
          },
          perception: {
            minLevel: perceptionLevel || current.push.perception.minLevel,
          },
        },
      }
      await options.overlay.write(next)
      return { saved: true, file: options.overlay.file, current: await options.overlay.current() }
    },
  }))

  for (const tool of tools) readToolNames.push(tool.name)
  return trackSessions([...tools, ...writeTools], options.state, options.sessionIdOf)
}

/**
 * Remember which session last touched Miloco.
 *
 * Every Miloco tool call marks its session as "the conversation that is
 * currently talking to the household". A later push with no explicit target
 * lands there. In DSH the durable session id is
 * `exec.agent.session.header.id`; `exec.agent.id` is also accepted for
 * compatibility with older builds.
 *
 * @param {any[]} tools - The tool definitions.
 * @param {any} state - The shared state store.
 * @param {(exec: any) => string} [sessionIdOf] - Session id extractor.
 * @returns {any[]} The same tools, with the tracker wired in.
 */
function trackSessions(tools, state, sessionIdOf) {
  if (!state) return tools
  const extract = typeof sessionIdOf === 'function'
    ? sessionIdOf
    : exec => exec?.agent?.session?.header?.id ?? exec?.agent?.id ?? ''
  for (const tool of tools) {
    const original = tool.execute
    tool.execute = async (args, exec) => {
      const sessionId = extract(exec)
      if (typeof sessionId === 'string' && sessionId !== '') {
        void noteSession(state, sessionId).catch(() => {})
      }
      return original(args, exec)
    }
  }
  return tools
}

/** Names of the write tools, used by `miloco_capabilities` to report what the plugin would expose. */
export const WRITE_TOOL_NAMES = [
  'miloco_device_control',
  'miloco_scene_trigger',
  'miloco_notify_push',
  'miloco_rule_create',
  'miloco_rule_delete',
  'miloco_task_create',
  'miloco_task_record_init',
  'miloco_task_delete',
  'miloco_cron_create',
  'miloco_cron_delete',
  'miloco_scope_set',
  'miloco_home_profile_write',
  'miloco_home_profile_candidate_write',
  'miloco_home_profile_commit',
  'miloco_home_profile_reassign',
  'miloco_person_create',
  'miloco_person_update',
  'miloco_person_delete',
  'miloco_pet_create',
  'miloco_pet_update',
  'miloco_pet_delete',
  'miloco_pet_observe',
  'miloco_pet_reference_crops',
  'miloco_register_preview',
  'miloco_register_commit',
  'miloco_push_target_set',
]

/**
 * Translate a caught error into a readable model-facing message.
 * @param {unknown} error - The caught error.
 * @returns {string} The message.
 */
export function errorMessage(error) {
  if (error instanceof MilocoError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
