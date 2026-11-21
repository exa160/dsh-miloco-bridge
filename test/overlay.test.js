import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createOverlay, normalizeOverlay, normalizePushTargetMode } from '../lib/overlay.js'

let workdir
before(async () => { workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-overlay-')) })
after(async () => { await rm(workdir, { recursive: true, force: true }) })

const fileFor = () => join(workdir, `overlay-${Math.random().toString(16).slice(2)}.json`)

describe('overlay schema', () => {
  it('defaults the household directory and push target mode', () => {
    const value = normalizeOverlay({})
    assert.equal(value.home.dir, '')
    assert.equal(value.push.target.mode, '')
    assert.equal(value.push.target.sessionId, '')
  })

  it('accepts only supported push target modes', () => {
    assert.equal(normalizePushTargetMode('archive'), 'archive')
    assert.equal(normalizePushTargetMode('session'), 'session')
    assert.equal(normalizePushTargetMode('other'), '')
    assert.equal(normalizePushTargetMode(undefined), '')
  })

  it('a target write preserves the household directory', async () => {
    const overlay = createOverlay({ file: fileFor() })
    await overlay.write({
      home: { dir: '/tmp/house' },
      push: { token: 't', target: { mode: 'session', sessionId: 's1' }, perception: { minLevel: 'high' } },
    })
    await overlay.write({ push: { target: { sessionId: 's2' } } })
    const value = await overlay.current()
    assert.equal(value.home.dir, '/tmp/house')
    assert.equal(value.push.token, 't')
    assert.equal(value.push.target.mode, 'session')
    assert.equal(value.push.target.sessionId, 's2')
    assert.equal(value.push.perception.minLevel, 'high')
  })

  it('a home write preserves the push token and mode', async () => {
    const overlay = createOverlay({ file: fileFor() })
    await overlay.write({ push: { token: 't', target: { mode: 'session', sessionId: 's1' } } })
    await overlay.write({ home: { dir: '/tmp/other' } })
    const value = await overlay.current()
    assert.equal(value.home.dir, '/tmp/other')
    assert.equal(value.push.token, 't')
    assert.equal(value.push.target.mode, 'session')
    assert.equal(value.push.target.sessionId, 's1')
  })

  it('an explicit empty value still clears a field', async () => {
    const overlay = createOverlay({ file: fileFor() })
    await overlay.write({ home: { dir: '/tmp/house' }, push: { token: 't' } })
    await overlay.write({ home: { dir: '' }, push: { token: '' } })
    const value = await overlay.current()
    assert.equal(value.home.dir, '')
    assert.equal(value.push.token, '')
  })
})
