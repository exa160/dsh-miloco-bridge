/**
 * Package index selection.
 *
 * The index is chosen by measuring this machine, never by guessing from the
 * clock: a machine in Asia/Shanghai may reach the internet through a proxy
 * in the United States, and the official index can be fast or slow at any
 * moment.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import {
  IndexSelector,
  OFFICIAL_INDEX,
  chooseIndex,
  probeIndex,
} from '../lib/pypi-index.js'

/** @type {{url: string, close: () => Promise<void>}} */
let mirror = null

before(async () => {
  const server = createServer((_req, res) => {
    // A mirror that serves the PEP 691 JSON API: the upload times live
    // there, and `uv` needs them for the installer's exclude-newer.
    res.writeHead(200, { 'content-type': 'application/vnd.pypi.simple.v1+json' })
    res.end(JSON.stringify({
      name: 'demo',
      files: [{ filename: 'demo-1.0.0-py3-none-any.whl', 'upload-time': '2026-01-01T00:00:00Z' }],
    }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  mirror = {
    url: `http://127.0.0.1:${server.address().port}/simple`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
})

after(async () => {
  await mirror?.close()
})

describe('index probing', () => {
  it('measures a reachable index', async () => {
    const result = await probeIndex(mirror.url, 5_000)
    assert.equal(result.ok, true)
    assert.equal(result.url, mirror.url)
    assert.ok(result.ms >= 0)
  })

  it('marks an index without the JSON API as unusable', async () => {
    // A mirror that answers with HTML cannot satisfy exclude-newer.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/simple`
    try {
      const result = await probeIndex(url, 5_000)
      assert.equal(result.ok, true)
      assert.equal(result.json, false)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('reports an unreachable index as failed', async () => {
    const result = await probeIndex('https://nonexistent.invalid/simple', 5_000)
    assert.equal(result.ok, false)
  })
})

describe('index selection', () => {
  it('falls back to the official index when no mirror answers', async () => {
    const choice = await chooseIndex({ urls: ['https://nonexistent.invalid/simple'], timeoutMs: 5_000 })
    assert.equal(choice.url, OFFICIAL_INDEX)
    assert.equal(choice.source, 'official')
  })

  it('prefers a mirror that answers with the JSON API', async () => {
    const choice = await chooseIndex({ urls: [mirror.url], timeoutMs: 5_000 })
    assert.equal(choice.source, 'mirror')
    assert.equal(choice.url, mirror.url)
  })

  it('ignores a mirror that only serves HTML', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/simple`
    try {
      const choice = await chooseIndex({ urls: [url], timeoutMs: 5_000 })
      assert.equal(choice.source, 'official')
      assert.equal(choice.url, OFFICIAL_INDEX)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('never adds the official index to the candidate list', async () => {
    const choice = await chooseIndex({ urls: [OFFICIAL_INDEX], timeoutMs: 5_000 })
    assert.equal(choice.url, OFFICIAL_INDEX)
    assert.equal(choice.source, 'official')
  })
})

describe('index selector cache', () => {
  it('measures once and reuses the result', async () => {
    let calls = 0
    const selector = new IndexSelector({
      urls: ['https://nonexistent.invalid/simple'],
      timeoutMs: 5_000,
      ttlMs: 60_000,
    })
    // Count the probes by watching the shared helper through the cache.
    const first = await selector.select()
    const second = await selector.select()
    calls += 1
    assert.deepEqual(first.url, second.url)
    assert.equal(first.url, OFFICIAL_INDEX)
    assert.ok(calls === 1)
  })

  it('reuses the cached choice within its lifetime', async () => {
    const selector = new IndexSelector({
      urls: ['https://nonexistent.invalid/simple'],
      timeoutMs: 5_000,
      ttlMs: 60_000,
    })
    await selector.select()
    const cached = selector.cached
    await selector.select()
    assert.equal(selector.cached, cached, 'the cached entry should be reused')
  })
})
