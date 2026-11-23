/**
 * Choosing the Python package index for the Miloco installer.
 *
 * The upstream release installer resolves the runtime dependencies with
 * `uv tool install`, and `uv` reads its index from the environment. The
 * plugin therefore only chooses the environment; `uv` and the installer stay
 * untouched.
 *
 * Two uv variables matter, and they are not interchangeable:
 *
 * - `UV_DEFAULT_INDEX` **replaces** the default index (`pypi.org`).
 * - `UV_INDEX` **adds** an index. `uv` queries every configured index and
 *   takes the first answer, so an added index is not a fallback — it
 *   competes with the default one and can slow the resolution down.
 *
 * The choice is made by measuring, not by guessing: a machine in `Asia/
 * Shanghai` can reach the internet through a proxy in the United States,
 * and the official index can be fast or slow at any given moment. The
 * probe measures what this machine can actually reach right now.
 *
 * @module dsh-miloco-bridge/pypi-index
 */

/** The official index. Always available, sometimes slow. */
export const OFFICIAL_INDEX = 'https://pypi.org/simple'

/**
 * Index candidates, fastest first by measurement on this machine.
 *
 * Only mirrors that serve the PEP 691 JSON API are listed: the upstream
 * installer pins its own dependencies with `exclude-newer`, and `uv` can
 * only satisfy that constraint when the index reports each file's upload
 * time. A mirror that serves HTML only makes the installation fail with
 * "no versions of <package> ... filtered by exclude-newer", no matter how
 * fast it is.
 */
export const MIRROR_INDEXES = [
  { url: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华' },
  { url: 'https://mirrors.bfsu.edu.cn/pypi/web/simple', label: '北外' },
  { url: 'https://mirrors.sjtug.sjtu.edu.cn/pypi/web/simple', label: '上交' },
  { url: 'https://mirrors.ustc.edu.cn/pypi/simple', label: '中科大' },
]

/** How long one probe waits for the first byte. */
const PROBE_TIMEOUT_MS = 8_000

/** A probe slower than this is not worth preferring over the official one. */
const PROBE_ACCEPT_MS = 3_000

/** How long a measured result stays valid. */
const PROBE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Probe one index and measure its time to first byte.
 *
 * The JSON API is requested on purpose: an index that only serves HTML
 * cannot satisfy the installer's `exclude-newer` constraint, because the
 * upload time of every file lives in the JSON representation.
 *
 * @param {string} url - The simple index URL.
 * @param {number} [timeoutMs] - Probe timeout.
 * @returns {Promise<{url: string, ok: boolean, json: boolean, ms: number}>} The measurement.
 */
export async function probeIndex(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'application/vnd.pypi.simple.v1+json' },
      })
      const text = await response.text().catch(() => '')
      const json = response.ok && text.trimStart().startsWith('{')
      return { url, ok: response.ok, json, ms: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { url, ok: false, json: false, ms: Date.now() - started }
  }
}

/**
 * Measure every candidate index and pick the fastest usable one.
 *
 * A candidate must answer with the JSON API: without the upload times it
 * reports, the installer cannot resolve its pinned dependencies.
 *
 * The official index is the fallback: it is only preferred when every
 * mirror failed, was too slow, or cannot serve the JSON API, so a broken
 * mirror never breaks the deployment.
 *
 * @param {{urls?: string[], timeoutMs?: number}} [options] - Options.
 * @returns {Promise<{url: string, source: 'mirror'|'official', ms: number, results: any[]}>} The choice.
 */
export async function chooseIndex(options = {}) {
  const candidates = (options.urls?.length ? options.urls : MIRROR_INDEXES.map(item => item.url))
    .filter(url => url && url !== OFFICIAL_INDEX)
  const results = await Promise.all(candidates.map(url => probeIndex(url, options.timeoutMs)))
  const usable = results
    .filter(result => result.ok && result.json && result.ms <= PROBE_ACCEPT_MS)
    .sort((left, right) => left.ms - right.ms)
  const best = usable[0]
  if (best) {
    return { url: best.url, source: 'mirror', ms: best.ms, results }
  }
  return { url: OFFICIAL_INDEX, source: 'official', ms: 0, results }
}

/**
 * A cached index choice, so a deployment does not probe on every run.
 */
export class IndexSelector {
  /**
   * @param {{urls?: string[], ttlMs?: number, timeoutMs?: number, logger?: any}} [options] - Options.
   */
  constructor(options = {}) {
    this.urls = options.urls?.length ? options.urls : MIRROR_INDEXES.map(item => item.url)
    this.ttlMs = options.ttlMs ?? PROBE_TTL_MS
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
    this.logger = options.logger
    this.cached = null
    this.pending = null
  }

  /**
   * The index to use, measured once and then reused.
   *
   * @returns {Promise<{url: string, source: 'mirror'|'official', ms: number, results: any[]}>} The choice.
   */
  async select() {
    const now = Date.now()
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.value
    if (!this.pending) {
      this.pending = chooseIndex({ urls: this.urls, timeoutMs: this.timeoutMs })
        .then((value) => {
          this.cached = { at: Date.now(), value }
          this.logger?.info?.(
            `dsh-miloco-bridge: 包索引选择：${value.url}（${value.source === 'mirror' ? '镜像' : '官方'}，${value.ms}ms）`,
          )
          return value
        })
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
  }
}
