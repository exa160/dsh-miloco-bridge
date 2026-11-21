import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { MAX_PUSH_LOG, createStateStore, notePush, readPushLog } from '../lib/state.js'

let workdir
before(async () => { workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-state-')) })
after(async () => { await rm(workdir, { recursive: true, force: true }) })

const storeFor = () => createStateStore({ file: join(workdir, `state-${Math.random().toString(16).slice(2)}.json`) })

describe('push log', () => {
  it('returns an empty log for a fresh store', async () => {
    assert.deepEqual(await readPushLog(storeFor()), [])
  })

  it('keeps the newest entry first and only the documented fields', async () => {
    const store = storeFor()
    await notePush(store, {
      at: 1,
      title: '门口',
      summary: '有人按门铃',
      sessionId: 'miloco-archive',
      status: 'ok',
      runId: 'run-1',
      message: 'should not persist',
    })
    const log = await readPushLog(store)
    assert.equal(log.length, 1)
    assert.deepEqual(log[0], {
      at: 1,
      title: '门口',
      summary: '有人按门铃',
      sessionId: 'miloco-archive',
      status: 'ok',
      runId: 'run-1',
    })
  })

  it('caps the log at MAX_PUSH_LOG entries', async () => {
    const store = storeFor()
    for (let i = 0; i < MAX_PUSH_LOG + 5; i += 1) {
      await notePush(store, { at: i, title: `t${i}`, summary: '', sessionId: 's', status: 'ok', runId: `r${i}` })
    }
    const log = await readPushLog(store)
    assert.equal(log.length, MAX_PUSH_LOG)
    assert.equal(log[0].title, `t${MAX_PUSH_LOG + 4}`)
  })

  it('ignores malformed entries', async () => {
    const store = storeFor()
    await store.write({ pushLog: [null, 'x', { at: 'nope' }] })
    const log = await readPushLog(store)
    assert.equal(log.length, 1)
    assert.equal(log[0].at, 0)
  })
})