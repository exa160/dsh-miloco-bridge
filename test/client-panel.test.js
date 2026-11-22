import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import vm from 'node:vm'

/**
 * A tiny React stand-in: enough to build the element tree of the pure page
 * helpers without a DOM.
 */
const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length > 0 ? children : undefined } }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useCallback(fn) { return fn },
  useRef(value) { return { current: value } },
  useMemo(fn) { return fn() },
}

/**
 * Load the browser half inside a sandbox and return its exports.
 * @returns {Promise<any>} The client exports.
 */
async function loadClient() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let exports = null
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {}, style: {} }),
      head: { appendChild() {} },
      body: {},
      querySelector: () => null,
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
  }
  sandbox.window = {
    setInterval,
    clearInterval,
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      load(spec) { exports = spec.factory(() => ReactStub) },
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  return exports
}

/**
 * Expand function components into their rendered output.
 *
 * The stub React never runs a component, so a child component would stay an
 * opaque element. Expanding it keeps the assertions on the real text.
 * @param {any} node - The element tree.
 * @returns {any} The expanded tree.
 */
function expand(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    return expand(node.type({ ...(node.props ?? {}) }))
  }
  return { type: node.type, props: { ...(node.props ?? {}), children: expand(node.props?.children) } }
}

/**
 * Collect every text node of a rendered tree.
 * @param {any} node - The element tree.
 * @returns {string[]} The text pieces.
 */
function texts(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(texts)
  const children = expand(node.props?.children)
  return texts(children)
}

/**
 * Collect every class name of a rendered tree.
 * @param {any} node - The element tree.
 * @returns {string[]} The class names.
 */
function classNames(node, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach(child => classNames(child, found))
    return found
  }
  if (typeof node.props?.className === 'string') found.push(node.props.className)
  classNames(expand(node.props?.children), found)
  return found
}

describe('household panel states', () => {
  it('picks the loading page before the first response', async () => {
    const client = await loadClient()
    assert.equal(client.milocoPanelState(null, null).kind, 'loading')
  })

  it('picks the error page when the request failed', async () => {
    const client = await loadClient()
    const view = client.milocoPanelState(null, 'HTTP 404')
    assert.equal(view.kind, 'error')
    assert.equal(view.error, 'HTTP 404')
  })

  it('picks the onboarding page when Miloco is unreachable', async () => {
    const client = await loadClient()
    const overview = {
      setup: { connection: { reachable: false, baseUrl: 'http://127.0.0.1:1810' } },
      status: { ok: false },
    }
    assert.equal(client.milocoPanelState(overview, null).kind, 'setup')
  })

  it('picks the onboarding page when the account is not bound', async () => {
    const client = await loadClient()
    const overview = {
      setup: {
        connection: { reachable: true, baseUrl: 'http://127.0.0.1:1810' },
        account: { bound: false },
      },
      status: { ok: true, accountBound: false },
    }
    assert.equal(client.milocoPanelState(overview, null).kind, 'setup')
  })

  it('picks the dashboard when Miloco answers and the account is bound', async () => {
    const client = await loadClient()
    const overview = {
      setup: {
        connection: { reachable: true },
        account: { bound: true },
      },
      status: { ok: true, accountBound: true },
    }
    assert.equal(client.milocoPanelState(overview, null).kind, 'dashboard')
  })

  it('falls back to the overview status on hosts without the setup block', async () => {
    const client = await loadClient()
    assert.equal(client.milocoPanelState({ status: { ok: true, accountBound: true } }, null).kind, 'dashboard')
    assert.equal(client.milocoPanelState({ status: { ok: false } }, null).kind, 'setup')
  })

  it('renders the loading page without the dashboard header', async () => {
    const client = await loadClient()
    const page = client.milocoLoadingPage()
    const classes = classNames(page)
    assert.ok(classes.includes('dsh-miloco-dash-state'))
    assert.ok(classes.includes('dsh-miloco-dash-spinner'))
    assert.ok(!classes.some(name => name.includes('dsh-miloco-dash-head')))
    assert.ok(!classes.some(name => name.includes('dsh-miloco-dash-actions')))
    assert.ok(texts(page).join('').includes('正在读取家庭概览'))
  })

  it('renders the error page with a retry action', async () => {
    const client = await loadClient()
    const page = client.milocoErrorPage('HTTP 500', () => {}, () => {})
    const joined = texts(page).join('|')
    assert.ok(joined.includes('HTTP 500'))
    assert.ok(joined.includes('重试'))
    assert.ok(joined.includes('打开配置'))
  })

  it('renders the onboarding page with three steps and its actions', async () => {
    const client = await loadClient()
    const overview = {
      setup: {
        connection: { reachable: false, baseUrl: 'http://127.0.0.1:1810' },
        accountBound: false,
        pushTokenSet: true,
        error: '无法连接 Miloco 后端',
      },
      status: { ok: false },
      push: { tokenSet: true },
    }
    const page = client.milocoSetupPage(overview, () => {}, () => {})
    const classes = classNames(page)
    assert.ok(classes.includes('dsh-miloco-dash-state'))
    assert.ok(classes.includes('dsh-miloco-dash-state-card'))
    assert.ok(!classes.some(name => name.includes('dsh-miloco-dash-head')))
    const joined = texts(page).join('|')
    assert.ok(joined.includes('家庭助手还没有初始化'))
    assert.ok(joined.includes('部署或连接 Miloco'))
    assert.ok(joined.includes('绑定米家账号'))
    assert.ok(joined.includes('接收 Miloco 推送'))
    assert.ok(joined.includes('开始配置'))
    assert.ok(joined.includes('重新检测'))
    // The push token is set, so its step is marked as done.
    assert.ok(classes.includes('dsh-miloco-dash-step done'))
  })

  it('offers the binding actions and the privacy note when the account is missing', async () => {
    const client = await loadClient()
    const overview = {
      setup: {
        connection: { reachable: true, baseUrl: 'http://127.0.0.1:1810' },
        account: { bound: false },
        accountBound: false,
        pushTokenSet: false,
        milocoUrl: 'http://127.0.0.1:1810',
      },
      status: { ok: true, accountBound: false },
      push: { tokenSet: false },
    }
    const page = client.milocoSetupPage(overview, () => {}, () => {})
    const joined = texts(page).join('|')
    assert.ok(joined.includes('在 Miloco 中绑定 ↗'))
    assert.ok(joined.includes('或在本页绑定'))
    assert.ok(joined.includes('隐私说明'))
    assert.ok(joined.includes('不会把账号、令牌或家庭数据上传到任何第三方'))
    // The link points at Miloco's own page and opens in a new tab.
    const links = []
    const collect = (node) => {
      const expanded = expand(node)
      if (!expanded || typeof expanded !== 'object') return
      if (Array.isArray(expanded)) return expanded.forEach(collect)
      if (expanded.type === 'a') links.push(expanded.props)
      collect(expanded.props?.children)
    }
    collect(page)
    const milocoLink = links.find(item => String(item.href ?? '').includes('1810'))
    assert.ok(milocoLink)
    assert.equal(milocoLink.target, '_blank')
    assert.equal(milocoLink.rel, 'noopener noreferrer')
  })

  it('hides the binding actions when Miloco is unreachable', async () => {
    const client = await loadClient()
    const overview = {
      setup: {
        connection: { reachable: false, baseUrl: 'http://127.0.0.1:1810' },
        account: { bound: false },
        accountBound: false,
        pushTokenSet: false,
        milocoUrl: 'http://127.0.0.1:1810',
      },
      status: { ok: false },
      push: { tokenSet: false },
    }
    const page = client.milocoSetupPage(overview, () => {}, () => {})
    assert.ok(!texts(page).join('|').includes('在 Miloco 中绑定 ↗'))
  })
})
