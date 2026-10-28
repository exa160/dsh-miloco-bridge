/**
 * GitHub release lookup with mirror fallback.
 *
 * Miloco only publishes on GitHub. Direct GitHub access is preferred; when it
 * is unavailable, the same API/installer URLs are requested through public
 * pull-through mirrors.
 *
 * @module dsh-miloco-bridge/github-release
 */

export const DEFAULT_GITHUB_REPO = 'XiaoMi/xiaomi-miloco'
export const DEFAULT_GITHUB_API = 'https://api.github.com'
export const DEFAULT_GITHUB_MIRRORS = [
  'https://gh-proxy.com/',
  'https://gh-proxy.org/',
]

/**
 * Normalise an owner/repo or GitHub URL to `owner/repo`.
 * @param {string} [repo] - Repository URL or slug.
 * @returns {string} Repository slug.
 */
export function normalizeRepo(repo) {
  const text = String(repo ?? '').trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const match = /^(?:https?:\/\/github\.com\/)?([^/\s]+\/[^/\s]+)$/i.exec(text)
  return match ? match[1] : DEFAULT_GITHUB_REPO
}

/**
 * Prefix a URL with a mirror, or expand a `{url}` template.
 * @param {string} mirror - Mirror base or template.
 * @param {string} url - Original URL.
 * @returns {string} Mirrored URL.
 */
export function viaMirror(mirror, url) {
  const base = String(mirror ?? '').trim()
  if (!base) return url
  if (base.includes('{url}')) return base.replaceAll('{url}', url)
  return `${base.replace(/\/+$/, '')}/${url}`
}

/**
 * Build direct + mirrored URLs for the latest-release API.
 * @param {{repo?: string, apiBase?: string, mirrors?: string[]}} [opts] - Options.
 * @returns {string[]} Candidate URLs, direct first.
 */
export function releaseApiUrls(opts = {}) {
  const repo = normalizeRepo(opts.repo)
  const apiBase = String(opts.apiBase || DEFAULT_GITHUB_API).replace(/\/+$/, '')
  const direct = `${apiBase}/repos/${repo}/releases/latest`
  const mirrors = (opts.mirrors ?? DEFAULT_GITHUB_MIRRORS).map(mirror => viaMirror(mirror, direct))
  return [...new Set([direct, ...mirrors])]
}

/**
 * Build direct + mirrored URLs for the release installer script.
 * @param {{repo?: string, mirrors?: string[]}} [opts] - Options.
 * @returns {string[]} Candidate URLs, direct first.
 */
export function releaseInstallerUrls(opts = {}) {
  const repo = normalizeRepo(opts.repo)
  const direct = `https://github.com/${repo}/releases/latest/download/install.sh`
  const mirrors = (opts.mirrors ?? DEFAULT_GITHUB_MIRRORS).map(mirror => viaMirror(mirror, direct))
  return [...new Set([direct, ...mirrors])]
}

/**
 * Fetch the latest release, trying direct GitHub then mirrors.
 * @param {{repo?: string, apiBase?: string, mirrors?: string[], timeoutMs?: number, fetchImpl?: typeof fetch}} [opts] - Options.
 * @returns {Promise<{tag: string, html_url: string, source: 'github'|'mirror', mirror: string|null, release_url: string, request_url: string}>} Latest release.
 */
export async function fetchLatestRelease(opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 6_000
  const urls = releaseApiUrls(opts)
  const errors = []
  for (const [index, url] of urls.entries()) {
    try {
      const response = await doFetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-miloco-bridge',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      const tag = String(body?.tag_name ?? '').trim()
      if (!tag) throw new Error('响应缺少 tag_name')
      const htmlUrl = String(body?.html_url ?? '').trim()
      const mirrored = index > 0
      const mirror = mirrored ? (opts.mirrors ?? DEFAULT_GITHUB_MIRRORS)[index - 1] : null
      return {
        tag,
        html_url: htmlUrl,
        source: mirrored ? 'mirror' : 'github',
        mirror,
        release_url: mirrored && htmlUrl ? viaMirror(mirror, htmlUrl) : htmlUrl,
        request_url: url,
      }
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`最新版本查询失败：${errors.join('; ')}`)
}

/**
 * Parse a CalVer/PEP440-style release string.
 * @param {string} value - Version string.
 * @returns {{parts: number[], post: number, dev: number|null}|null} Parsed version.
 */
export function parseReleaseVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '').split('+')[0]
  const match = /^(\d+(?:\.\d+)*)(?:\.post(\d+))?(?:\.dev(\d+))?$/.exec(text)
  if (!match) return null
  return {
    parts: match[1].split('.').map(Number),
    post: Number(match[2] ?? 0),
    dev: match[3] === undefined ? null : Number(match[3]),
  }
}

/**
 * Normalise a release tag for display.
 * @param {string} value - Tag or version.
 * @returns {string} Version without a leading `v`.
 */
export function normalizeReleaseVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '')
}

/**
 * Whether `latest` is strictly newer than `current`.
 * Dev builds and unparseable versions are treated conservatively as "no update".
 * @param {string} current - Current version.
 * @param {string} latest - Latest release tag.
 * @returns {boolean} Whether an update is available.
 */
export function isNewerRelease(current, latest) {
  const left = parseReleaseVersion(current)
  const right = parseReleaseVersion(latest)
  if (!left || !right) return false
  if (left.dev !== null) return false
  const length = Math.max(left.parts.length, right.parts.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.parts[index] ?? 0
    const b = right.parts[index] ?? 0
    if (b !== a) return b > a
  }
  return right.post > left.post
}

/**
 * Infer release/dev deployment kind from a package version.
 * @param {string} version - Package version.
 * @returns {'release'|'dev'} Deployment kind.
 */
export function inferDeployKind(version) {
  return /\.dev\d*|\+/.test(String(version ?? '')) ? 'dev' : 'release'
}
