/**
 * dsh-miloco-bridge — browser half.
 *
 * A 「Miloco」 tab inside the Web GUI's 「设置 → 插件」 page:
 *
 * 1. whether Miloco is reachable; if not, one-click deploy or connect;
 * 2. household overview (account, devices, cameras, rules/tasks, token usage);
 * 3. push destination: a conversation and an optional model;
 * 4. the dedicated agent's operating mode.
 *
 * Model selection deliberately has no "deployment default" pseudo-entry:
 * leaving it empty means the conversation keeps its own model.
 *
 * @module dsh-miloco-bridge/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-miloco-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    /** Client services: the slot registry. */
    const inject = ['slots']

    /** Settings API prefix, mirrored from the host half. */
    const API = '/dsh-miloco-bridge/api'

    /** Tab identity inside 「设置 → 插件」. */
    const TAB_ID = 'dsh-miloco-bridge'

    const STYLE_ID = 'dsh-miloco-bridge-settings-style'
    const SESSION_LIST_ID = 'dsh-miloco-bridge-session-list'

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-miloco-bridge-settings { font-size: 13px; line-height: 1.6; max-width: 780px; }
.dsh-miloco-bridge-settings h3 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
.dsh-miloco-bridge-settings .card { border: 1px solid rgba(128,128,128,.32); border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.dsh-miloco-bridge-settings .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px 14px; margin-top: 6px; }
.dsh-miloco-bridge-settings .stat { display: flex; flex-direction: column; }
.dsh-miloco-bridge-settings .stat .k { opacity: .66; font-size: 12px; }
.dsh-miloco-bridge-settings .stat .v { font-size: 16px; font-weight: 600; }
.dsh-miloco-bridge-settings .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.dsh-miloco-bridge-settings .row > label { min-width: 96px; opacity: .8; }
.dsh-miloco-bridge-settings select, .dsh-miloco-bridge-settings input {
  flex: 1 1 220px; min-width: 160px; padding: 5px 8px; border-radius: 6px;
  border: 1px solid rgba(128,128,128,.36); background: transparent; color: inherit; font: inherit;
}
.dsh-miloco-bridge-settings button {
  padding: 5px 14px; border-radius: 6px; border: 1px solid rgba(128,128,128,.36);
  background: transparent; color: inherit; font: inherit; cursor: pointer;
}
.dsh-miloco-bridge-settings button.primary { border-color: rgba(70,130,220,.7); color: rgba(70,130,220,1); }
.dsh-miloco-bridge-settings button:disabled { opacity: .5; cursor: default; }
.dsh-miloco-bridge-settings .pill {
  display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
  border: 1px solid rgba(128,128,128,.36);
}
.dsh-miloco-bridge-settings .pill.ok { border-color: rgba(60,160,90,.6); color: rgba(60,160,90,1); }
.dsh-miloco-bridge-settings .pill.bad { border-color: rgba(200,90,80,.6); color: rgba(200,90,80,1); }
.dsh-miloco-bridge-settings .pill.warn { border-color: rgba(210,150,50,.6); color: rgba(210,150,50,1); }
.dsh-miloco-bridge-settings .muted { opacity: .68; font-size: 12px; }
.dsh-miloco-bridge-settings .modeList { display: flex; flex-direction: column; gap: 4px; margin: 10px 0 6px; }
.dsh-miloco-bridge-settings .modeItem { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 6px 8px; border-radius: 6px; }
.dsh-miloco-bridge-settings .modeItem:hover { background: rgba(128,128,128,.08); }
.dsh-miloco-bridge-settings .modeText { display: flex; flex-direction: column; gap: 2px; }
.dsh-miloco-bridge-settings .modeText .muted { margin: 0; }
.dsh-miloco-bridge-settings a { color: rgba(70,130,220,1); text-decoration: none; }
.dsh-miloco-bridge-settings a:hover { text-decoration: underline; }
.dsh-miloco-bridge-settings .danger { border: 1px solid rgba(200,90,80,.5); border-radius: 8px; padding: 10px 12px; margin-top: 10px; }
.dsh-miloco-bridge-settings .danger h4 { margin: 0 0 6px; font-size: 13px; color: rgba(200,90,80,1); }
.dsh-miloco-bridge-settings .danger label { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0; font-size: 12px; }
.dsh-miloco-bridge-settings .guide { margin: 8px 0 0; padding: 10px 12px; border-radius: 6px; border: 1px solid rgba(128,128,128,.28); background: rgba(128,128,128,.06); }
.dsh-miloco-bridge-settings .guide h4 { margin: 8px 0 4px; font-size: 13px; }
.dsh-miloco-bridge-settings .guide ul { margin: 4px 0; padding-left: 18px; }
.dsh-miloco-bridge-settings .guide li { margin: 2px 0; }
.dsh-miloco-bridge-settings code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dsh-miloco-bridge-settings pre {
  margin: 8px 0 0; padding: 8px 10px; border-radius: 6px; max-height: 260px; overflow: auto;
  border: 1px solid rgba(128,128,128,.28); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap;
}
`
      document.head.appendChild(style)
    }

    async function call(path, init) {
      const response = await fetch(`${API}${path}`, init)
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      return body
    }

    /**
     * Build model options. The first option is "follow the conversation";
     * there is no pseudo-entry for any deployment default.
     * @param {any} status - Settings payload.
     * @returns {any[]} Option elements.
     */
    function modelOptions(status) {
      const options = [h('option', { key: '__follow__', value: '' }, '跟随该对话自己选的模型')]
      for (const provider of status?.providers ?? []) {
        const group = []
        for (const model of provider.models ?? []) {
          group.push(h('option', {
            key: `${provider.id}/${model.id}`,
            value: `${provider.id}/${model.id}`,
          }, `${provider.name} / ${model.name || model.id}`))
        }
        if (group.length > 0) {
          options.push(h('optgroup', { key: provider.id, label: provider.name }, group))
        }
      }
      return options
    }

    /**
     * Read the reasoning-effort options advertised by the selected model.
     * @param {any} status - Settings payload.
     * @param {string} modelValue - `${provider}/${model}` selection.
     * @returns {{id: string, name?: string, description?: string}[]} Effort options.
     */
    function effortOptions(status, modelValue) {
      if (!modelValue) return []
      const [providerId, ...rest] = modelValue.split('/')
      const modelId = rest.join('/')
      const provider = (status?.providers ?? []).find(item => item.id === providerId)
      const model = (provider?.models ?? []).find(item => item.id === modelId)
      return Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []
    }

    /**
     * Build the datalist entries for conversations.
     * @param {any} status - Settings payload.
     * @returns {any[]} Option elements.
     */
    function sessionOptions(status) {
      const sessions = status?.sessions ?? []
      const options = []
      for (const session of sessions) {
        const title = session.title || session.id
        const tags = [
          session.lastMiloco ? '上次 miloco' : '',
          session.live ? '' : '已归档',
          session.agentPreset ? `预设 ${session.agentPreset}` : '',
        ].filter(Boolean)
        const label = tags.length ? `${title} — ${session.id}（${tags.join(' · ')}）` : `${title} — ${session.id}`
        options.push(h('option', { key: session.id, value: session.id, label }, label))
      }
      return options
    }

    function MilocoSettingsTab() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [saved, setSaved] = React.useState(null)
      const [sessionId, setSessionId] = React.useState('')
      const [modelValue, setModelValue] = React.useState('')
      const [reasoningEffort, setReasoningEffort] = React.useState('')
      const [deployLog, setDeployLog] = React.useState('')
      const [connectOpen, setConnectOpen] = React.useState(false)
      const [connectUrl, setConnectUrl] = React.useState('')
      const [connectToken, setConnectToken] = React.useState('')
      const [connectPushToken, setConnectPushToken] = React.useState('')
      const [mode, setMode] = React.useState('readonly')
      const [perceptionLevel, setPerceptionLevel] = React.useState('all')
      const [guideOpen, setGuideOpen] = React.useState(false)
      const [uninstallOpen, setUninstallOpen] = React.useState(false)
      const [removeData, setRemoveData] = React.useState(false)
      const [removeSource, setRemoveSource] = React.useState(false)
      const [confirmText, setConfirmText] = React.useState('')
      const [uninstallBusy, setUninstallBusy] = React.useState(false)
      const [uninstallResult, setUninstallResult] = React.useState(null)

      const reload = React.useCallback(() => {
        setError(null)
        call('/status')
          .then((payload) => {
            setStatus(payload)
            setSessionId(payload.overlay?.push?.target?.sessionId ?? '')
            const provider = payload.overlay?.push?.model?.provider ?? ''
            const model = payload.overlay?.push?.model?.model ?? ''
            setModelValue(provider && model ? `${provider}/${model}` : '')
            setReasoningEffort(provider && model ? (payload.overlay?.push?.model?.reasoningEffort ?? '') : '')
            setConnectUrl(payload.connection?.baseUrl ?? '')
            setMode(payload.mode?.id ?? 'readonly')
            setPerceptionLevel(payload.overlay?.push?.perception?.minLevel ?? payload.push?.perception?.minLevel ?? 'all')
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }, [])

      React.useEffect(() => { reload() }, [reload])

      const refreshSessions = React.useCallback(() => {
        call('/sessions')
          .then((payload) => {
            setStatus((previous) => previous
              ? { ...previous, sessions: payload.sessions, lastMilocoSession: payload.last }
              : previous)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }, [])

      const save = React.useCallback(() => {
        setBusy(true)
        setSaved(null)
        setError(null)
        const [provider, ...rest] = modelValue.split('/')
        const model = rest.join('/')
        const efforts = effortOptions(status, modelValue)
        const effort = modelValue && efforts.some(item => item.id === reasoningEffort)
          ? reasoningEffort
          : ''
        call('/target', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            provider: modelValue ? provider : '',
            model: modelValue ? model : '',
            reasoningEffort: effort,
            perceptionLevel,
          }),
        })
          .then((payload) => {
            setSaved('已保存')
            setStatus((previous) => previous ? { ...previous, overlay: payload.overlay } : previous)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [sessionId, modelValue, reasoningEffort, perceptionLevel, status])

      const deploy = React.useCallback(() => {
        setBusy(true)
        setError(null)
        call('/deploy', { method: 'POST' })
          .then(() => {
            const poll = () => {
              call('/deploy')
                .then((payload) => {
                  setDeployLog(payload.log ?? '')
                  if (payload.state?.running) {
                    window.setTimeout(poll, 3000)
                  } else {
                    setBusy(false)
                    reload()
                  }
                })
                .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
            }
            poll()
          })
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
      }, [reload])

      const saveMode = React.useCallback((next) => {
        setBusy(true)
        setError(null)
        call('/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        })
          .then((payload) => {
            setMode(payload.mode?.id ?? next)
            setSaved(`已切到「${payload.mode?.label ?? next}」，重启 DSH 后生效`)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [])

      const connect = React.useCallback(() => {
        setBusy(true)
        setError(null)
        call('/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: connectUrl,
            token: connectToken,
            ...(connectPushToken ? { pushToken: connectPushToken } : {}),
          }),
        })
          .then((payload) => {
            setSaved(payload.reachable ? '连接成功，立即生效' : '已保存，但暂时连不上')
            setConnectOpen(false)
            reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [connectUrl, connectToken, connectPushToken, reload])

      const uninstall = React.useCallback(() => {
        if (confirmText !== 'UNINSTALL') return
        setUninstallBusy(true)
        setUninstallResult(null)
        setError(null)
        call('/uninstall', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: confirmText, removeData, removeSource }),
        })
          .then((payload) => {
            setUninstallResult(payload.note || '已停止 Miloco 服务并清除插件连接。')
            setUninstallOpen(false)
            setConfirmText('')
            setRemoveData(false)
            setRemoveSource(false)
            reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setUninstallBusy(false))
      }, [confirmText, removeData, removeSource, reload])

      if (error && !status) {
        return h('div', { className: 'dsh-miloco-bridge-settings' },
          h('div', { className: 'card' },
            h('h3', null, 'Miloco'),
            h('span', { className: 'pill bad' }, '读取失败'),
            h('div', { className: 'muted' }, error)))
      }
      if (!status) {
        return h('div', { className: 'dsh-miloco-bridge-settings' },
          h('div', { className: 'card' }, h('div', { className: 'muted' }, '正在读取 Miloco 状态…')))
      }

      const backend = status.backend ?? {}
      const connection = status.connection ?? {}
      const push = status.push ?? {}
      const overview = status.overview ?? null
      const adapter = status.adapter ?? {}
      const reachable = Boolean(backend.reachable)
      const cards = []

      const connectForm = connectOpen
        ? h('div', null,
          h('div', { className: 'row' },
            h('input', {
              type: 'text', value: connectUrl, placeholder: 'http://miloco.local:1810',
              onChange: (event) => setConnectUrl(event.target.value),
            })),
          h('div', { className: 'row' },
            h('input', {
              type: 'password', value: connectToken, placeholder: '后端 token（config.json 的 server.token，可留空）',
              onChange: (event) => setConnectToken(event.target.value),
            })),
          h('div', { className: 'row' },
            h('input', {
              type: 'password', value: connectPushToken,
              placeholder: '推送令牌（留空 = 与后端 token 相同）',
              onChange: (event) => setConnectPushToken(event.target.value),
            })),
          h('div', { className: 'row' },
            h('button', { type: 'button', disabled: busy || !connectUrl, onClick: connect }, '连接')))
        : null

      // ---------------------------------------------------------------- 部署 / 连接
      if (!reachable) {
        cards.push(h('div', { className: 'card', key: 'deploy' },
          h('h3', null, 'Miloco 尚未连接'),
          h('div', { className: 'muted' },
            backend.error || `连不上 ${connection.baseUrl || '（未配置地址）'}。`
            + '插件本身可以独立安装；部署或连接之后才会出现设备与感知能力。'),
          h('div', { className: 'row' },
            h('button', { type: 'button', className: 'primary', disabled: busy, onClick: deploy },
              busy ? '部署中…' : '一键部署 Miloco'),
            h('button', { type: 'button', disabled: busy, onClick: () => setConnectOpen(!connectOpen) },
              connectOpen ? '收起' : '连接已有的 Miloco')),
          connectForm,
          deployLog ? h('pre', null, deployLog) : null))
      }

      // ---------------------------------------------------------------- 家庭概览
      if (reachable && overview) {
        cards.push(h('div', { className: 'card', key: 'overview' },
          h('h3', null, '家庭概览'),
          h('div', { className: 'grid' },
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, '米家账号'),
              h('span', { className: 'v' }, overview.account?.nickname || (overview.accountBound ? '已绑定' : '未绑定'))),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, '设备'),
              h('span', { className: 'v' }, overview.deviceCount ?? '—')),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, '摄像头'),
              h('span', { className: 'v' }, overview.cameraCount ?? '—')),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, '规则 / 任务'),
              h('span', { className: 'v' }, `${overview.ruleCount ?? '—'} / ${overview.taskCount ?? '—'}`)),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, '感知引擎'),
              h('span', { className: 'v' }, overview.perceptionRunning ? '运行中' : '未运行')),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, '感知源'),
              h('span', { className: 'v' }, overview.perceptionSources ?? '—')),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, 'token 记录'),
              h('span', { className: 'v' }, overview.tokenEvents ?? '—')),
            h('div', { className: 'stat' },
              h('span', { className: 'k' }, 'token 合计'),
              h('span', { className: 'v' }, overview.tokenTotal ?? '—')))))
      }

      // ---------------------------------------------------------------- 运行模式
      const modes = status.modes ?? []
      cards.push(h('div', { className: 'card', key: 'mode' },
        h('h3', null, 'Miloco 家庭助手 · 运行模式'),
        h('div', { className: 'muted' },
          '米家工具与技能只挂在「Miloco 家庭助手」这个 Agent 预设上，普通对话完全不受影响。'),
        h('div', { className: 'muted' }, '模式决定这个预设手里有哪些工具：'),
        h('div', { className: 'modeList' }, modes.map(item => h('label', {
          key: item.id,
          className: 'modeItem',
        },
        h('input', {
          type: 'radio', name: 'dsh-miloco-bridge-mode', checked: mode === item.id,
          onChange: () => saveMode(item.id),
        }),
        h('div', { className: 'modeText' },
          h('strong', null, item.label),
          h('div', { className: 'muted' }, item.description))))),
        h('div', { className: 'muted' },
          '切换后重启 DSH（或重新挂载该预设）才生效；已有会话保留创建时拿到的工具集。'),
        h('div', { className: 'row' },
          h('button', { type: 'button', disabled: busy, onClick: () => setGuideOpen(!guideOpen) },
            guideOpen ? '收起使用说明' : '查看模式说明与用法'))))

      if (guideOpen) {
        cards.push(h('div', { className: 'card', key: 'guide' },
          h('h3', null, 'Miloco 家庭助手 · 使用说明'),
          h('div', { className: 'muted' },
            'DSH 的「模式说明 / 如何使用」弹窗目前只为内置预设提供；Miloco 是第三方预设，'
            + '等价说明放在这里。'),
          h('div', { className: 'guide' },
            h('h4', null, '模式说明'),
            h('ul', null,
              h('li', null, h('strong', null, '只读模式：'), '只能查设备、问摄像头、看档案与用量；写工具不会被注册，不会控制任何设备。'),
              h('li', null, h('strong', null, '管家模式：'), '在只读能力上增加设备控制、场景触发、通知、规则/任务、档案写入、成员与宠物登记。')),
            h('h4', null, '如何使用'),
            h('ul', null,
              h('li', null, '新建会话时选择「Miloco 家庭助手」；其他对话不会出现 miloco_* 工具。'),
              h('li', null, '在本页选择运行模式；切换后重启 DSH 或重新挂载预设生效。'),
              h('li', null, '推送目标留空 = 投到上一次触发 Miloco 的会话；也可以指定任意会话。'),
              h('li', null, '模型留空 = 跟随该对话；选择模型后，该对话会用指定模型处理推送。')),
            h('h4', null, '可以这样问'),
            h('ul', null,
              h('li', null, '“客厅现在有人吗？” / “刚才门口发生了什么？”'),
              h('li', null, '“把客厅灯打开” / “执行回家模式”'),
              h('li', null, '“奶奶对什么过敏？” / “记一下孩子每天喝几杯水”'),
              h('li', null, '“最近 token 用量多少？” / “为什么这条规则没触发？”')))))
      }

      // ---------------------------------------------------------------- 推送目标
      const lastSession = status.lastMilocoSession ?? ''
      const selectedEfforts = effortOptions(status, modelValue)
      const effortValue = selectedEfforts.some(item => item.id === reasoningEffort)
        ? reasoningEffort
        : ''
      cards.push(h('div', { className: 'card', key: 'target' },
        h('h3', null, '推送目标'),
        h('div', { className: 'row' },
          h('label', null, '对话会话'),
          h('input', {
            type: 'text',
            list: SESSION_LIST_ID,
            value: sessionId,
            placeholder: lastSession
              ? `留空 = 上一次触发 miloco 的会话（${lastSession}）`
              : '留空 = 上一次触发 miloco 的会话（还没有）',
            onChange: (event) => setSessionId(event.target.value),
          }),
          h('datalist', { id: SESSION_LIST_ID }, sessionOptions(status)),
          h('button', { type: 'button', disabled: busy, onClick: refreshSessions }, '刷新会话')),
        h('div', { className: 'muted' },
          '留空 = 投到「上一次触发 miloco 的会话」，也就是最近一次调用过米家工具的对话。'
          + '也可以从下拉里选任意对话，或直接填会话 id。'),
        h('div', { className: 'row' },
          h('label', null, '模型'),
          h('select', {
            value: modelValue,
            onChange: (event) => {
              setModelValue(event.target.value)
              setReasoningEffort('')
            },
          }, modelOptions(status))),
        selectedEfforts.length > 0
          ? h('div', { className: 'row' },
            h('label', null, '推理强度'),
            h('select', {
              value: effortValue,
              onChange: (event) => setReasoningEffort(event.target.value),
            }, [
              h('option', { key: '__model_default__', value: '' }, '跟随模型默认'),
              ...selectedEfforts.map(item => h('option', {
                key: item.id,
                value: item.id,
              }, item.name || item.id)),
            ]))
          : null,
        h('div', { className: 'row' },
          h('label', null, '感知等级'),
          h('select', {
            value: perceptionLevel,
            onChange: (event) => setPerceptionLevel(event.target.value),
          }, [
            h('option', { key: 'all', value: 'all' }, '全部事件'),
            h('option', { key: 'low', value: 'low' }, '低及以上'),
            h('option', { key: 'medium', value: 'medium' }, '中及以上'),
            h('option', { key: 'high', value: 'high' }, '仅高优先级'),
          ])),
        h('div', { className: 'muted' },
          '低于所选等级的感知建议不会投递到 DSH；规则、任务、onboarding 与普通对话事件不受影响。'),
        h('div', { className: 'row' },
          h('button', { type: 'button', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          saved ? h('span', { className: 'pill ok' }, saved) : null,
          error ? h('span', { className: 'pill bad' }, error) : null),
        h('div', { className: 'muted' },
          `保存位置：${status.overlayFile ?? '—'}（立即生效，不必重启）`)))

      // ---------------------------------------------------------------- 运行状态
      const deployState = status.deploy ?? {}
      cards.push(h('div', { className: 'card', key: 'runtime' },
        h('h3', null, '运行状态'),
        h('div', { className: 'row' },
          h('label', null, '后端'),
          connection.baseUrl
            ? h('a', {
              href: connection.baseUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: '在新标签页打开 Miloco 面板',
            }, connection.baseUrl)
            : h('code', null, '—'),
          h('span', { className: `pill ${reachable ? 'ok' : 'bad'}` }, reachable ? '已连通' : '连不上'),
          h('span', { className: 'muted' }, `来源：${connection.source ?? '—'}`)),
        h('div', { className: 'row' },
          h('label', null, '推送入口'),
          h('code', null, push.path || '—'),
          h('span', { className: `pill ${push.tokenSet ? 'ok' : 'bad'}` },
            push.tokenSet ? '令牌已配置' : '令牌未配置')),
        h('div', { className: 'row' },
          h('label', null, 'Miloco adapter'),
          h('span', { className: `pill ${adapter.active ? 'ok' : (adapter.installed ? 'warn' : '')}` },
            adapter.active ? '已启用' : (adapter.installed ? '已安装未启用' : '未安装')),
          h('span', { className: 'muted' },
            adapter.installed
              ? `agent.platform=${adapter.agentPlatform || '未设置'}`
              : '安装 Miloco 后可一键写入 adapter 与令牌')),
        h('div', { className: 'row' },
          h('label', null, '配置位置'),
          h('span', { className: 'muted' },
            `插件默认：${status.configLocation?.bundle ?? ''}；`
            + `profile 覆盖：${status.configLocation?.profile ?? ''}`)),
        h('div', { className: 'row' },
          h('button', { type: 'button', disabled: busy, onClick: reload }, '刷新'),
          h('button', { type: 'button', disabled: busy, onClick: () => setConnectOpen(!connectOpen) },
            connectOpen ? '收起连接设置' : '修改连接'),
          h('button', {
            type: 'button',
            disabled: uninstallBusy,
            onClick: () => setUninstallOpen(!uninstallOpen),
          }, uninstallOpen ? '收起卸载' : '卸载 Miloco')),
        reachable ? connectForm : null,
        uninstallResult ? h('div', { className: 'muted' }, uninstallResult) : null,
        uninstallOpen
          ? h('div', { className: 'danger' },
            h('h4', null, '卸载 Miloco'),
            h('div', { className: 'muted' },
              '会停止 Miloco 服务、移除 DSH 侧 adapter，并清空本插件的连接与推送令牌。'),
            h('label', null,
              h('input', {
                type: 'checkbox', checked: removeSource,
                onChange: (event) => setRemoveSource(event.target.checked),
              }),
              h('span', null, `删除源码目录：${deployState.sourceDir || '（未知）'}`)),
            h('label', null,
              h('input', {
                type: 'checkbox', checked: removeData,
                onChange: (event) => setRemoveData(event.target.checked),
              }),
              h('span', null,
                `删除 Miloco 数据目录：${deployState.milocoHome || '（未知）'}`
                + '（账号绑定、数据库、感知记录，不可恢复）')),
            h('div', { className: 'row' },
              h('input', {
                type: 'text', value: confirmText, placeholder: '输入 UNINSTALL 确认',
                onChange: (event) => setConfirmText(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: 'primary',
                disabled: uninstallBusy || confirmText !== 'UNINSTALL',
                onClick: uninstall,
              }, uninstallBusy ? '卸载中…' : '确认卸载')))
          : null))

      // 运行状态固定排在第二格（概览之后；未连接时在部署卡之后）。
      const order = ['deploy', 'overview', 'runtime', 'mode', 'guide', 'target']
      cards.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))

      return h('div', { className: 'dsh-miloco-bridge-settings' }, cards)
    }

    function apply(ctx) {
      ensureStyles()
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: TAB_ID,
        order: 20,
        label: 'Miloco',
      }, MilocoSettingsTab))
    }

    exports.apply = apply
    exports.inject = inject
    exports.MilocoSettingsTab = MilocoSettingsTab
    exports.modelOptions = modelOptions
    exports.sessionOptions = sessionOptions
    exports.effortOptions = effortOptions
    return module.exports
  },
})
