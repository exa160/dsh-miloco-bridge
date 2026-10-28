import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  fetchLatestRelease,
  isNewerRelease,
  normalizeRepo,
  releaseApiUrls,
  releaseInstallerUrls,
  viaMirror,
} from '../lib/github-release.js'

describe('GitHub release helpers', () => {
  it('normalizes repositories and mirror URLs', () => {
    assert.equal(normalizeRepo('https://github.com/XiaoMi/xiaomi-miloco.git'), 'XiaoMi/xiaomi-miloco')
    assert.equal(normalizeRepo('XiaoMi/xiaomi-miloco'), 'XiaoMi/xiaomi-miloco')
    assert.equal(
      viaMirror('https://gh-proxy.com/', 'https://api.github.com/x'),
      'https://gh-proxy.com/https://api.github.com/x',
    )
    assert.equal(viaMirror('https://m.test/{url}', 'https://x'), 'https://m.test/https://x')
  })

  it('builds direct-first API and installer URLs', () => {
    const api = releaseApiUrls({ repo: 'XiaoMi/xiaomi-miloco', mirrors: ['https://m.test/'] })
    assert.deepEqual(api, [
      'https://api.github.com/repos/XiaoMi/xiaomi-miloco/releases/latest',
      'https://m.test/https://api.github.com/repos/XiaoMi/xiaomi-miloco/releases/latest',
    ])
    const installer = releaseInstallerUrls({ repo: 'XiaoMi/xiaomi-miloco', mirrors: ['https://m.test/'] })
    assert.equal(installer[0], 'https://github.com/XiaoMi/xiaomi-miloco/releases/latest/download/install.sh')
    assert.equal(installer[1], 'https://m.test/https://github.com/XiaoMi/xiaomi-miloco/releases/latest/download/install.sh')
  })

  it('compares CalVer releases conservatively', () => {
    assert.equal(isNewerRelease('2026.9.11', 'v2026.10.16'), true)
    assert.equal(isNewerRelease('2026.10.16', 'v2026.10.16'), false)
    assert.equal(isNewerRelease('2026.10.16.post1', 'v2026.10.16'), false)
    assert.equal(isNewerRelease('2026.10.16.post1.dev0', 'v2026.10.17'), false)
  })

  it('falls back to a mirror when direct GitHub fails', async () => {
    const calls = []
    const fetchImpl = async url => {
      calls.push(url)
      if (url.startsWith('https://api.github.com/')) throw new Error('offline')
      return {
        ok: true,
        json: async () => ({ tag_name: 'v2026.10.16', html_url: 'https://github.com/x/y/releases/tag/v2026.10.16' }),
      }
    }
    const result = await fetchLatestRelease({
      repo: 'XiaoMi/xiaomi-miloco',
      mirrors: ['https://mirror.test/'],
      fetchImpl,
    })
    assert.equal(calls.length, 2)
    assert.equal(result.source, 'mirror')
    assert.equal(result.tag, 'v2026.10.16')
    assert.equal(result.release_url, 'https://mirror.test/https://github.com/x/y/releases/tag/v2026.10.16')
  })

  it('throws when every candidate fails', async () => {
    await assert.rejects(
      () => fetchLatestRelease({
        mirrors: ['https://mirror.test/'],
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
      }),
      /最新版本查询失败/,
    )
  })
})
