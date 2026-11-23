/**
 * Miloco HTTP client: timeout classification and per-request overrides.
 *
 * A slow endpoint (multimodal perception measured 58–78 s) must surface as a
 * timeout, never as "无法连接 Miloco 后端" — that message sends the model to
 * check whether Miloco is running when the backend is actually fine.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, describe, it } from 'node:test'

import { createMilocoClient, MilocoError } from '../lib/miloco-client.js'

/** @type {{baseUrl: string, close: () => Promise<void>}} */
let slow = null

/**
 * Start a backend that answers `/api/slow` only after `delayMs`.
 * @param {number} delayMs - Response delay.
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>} The server.
 */
async function startDelayed(delayMs) {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, data: { ok: true } }))
    }, delayMs).unref?.()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

before(async () => {
  slow = await startDelayed(300)
})

after(async () => {
  await slow?.close()
})

describe('Miloco client timeouts', () => {
  it('reports a client-wide timeout as a timeout, not a connection failure', async () => {
    const client = createMilocoClient({ baseUrl: slow.baseUrl, timeoutMs: 50 })
    await assert.rejects(
      () => client.get('/api/slow'),
      (error) => {
        assert.ok(error instanceof MilocoError)
        assert.match(error.message, /响应超时/)
        assert.doesNotMatch(error.message, /无法连接/)
        assert.doesNotMatch(error.message, /请确认 Miloco 已启动/)
        return true
      },
    )
  })

  it('a per-request timeoutMs override lets a slow call succeed', async () => {
    const client = createMilocoClient({ baseUrl: slow.baseUrl, timeoutMs: 50 })
    // Default would abort at 50 ms; the override outlives the 300 ms delay.
    const data = await client.post('/api/slow', {}, { timeoutMs: 5_000 })
    assert.deepEqual(data, { ok: true })
  })

  it('a per-request timeoutMs override can also fail with a timeout message', async () => {
    const client = createMilocoClient({ baseUrl: slow.baseUrl, timeoutMs: 60_000 })
    await assert.rejects(
      () => client.get('/api/slow', { timeoutMs: 50 }),
      (error) => {
        assert.ok(error instanceof MilocoError)
        assert.match(error.message, /响应超时/)
        return true
      },
    )
  })

  it('a refused connection still reports a connection failure', async () => {
    // Port 1 is reserved: connect always fails fast on loopback.
    const client = createMilocoClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 5_000 })
    await assert.rejects(
      () => client.get('/api/admin/status'),
      (error) => {
        assert.ok(error instanceof MilocoError)
        assert.match(error.message, /无法连接/)
        assert.match(error.message, /请确认 Miloco 已启动/)
        return true
      },
    )
  })

  it('a rejected credential asks for a new backend token instead of showing the envelope', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 1003, message: 'Invalid or missing service token', data: null }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = createMilocoClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 5_000 })
    try {
      await assert.rejects(
        () => client.get('/api/admin/status'),
        (error) => {
          assert.ok(error instanceof MilocoError)
          assert.match(error.message, /后端令牌无效或缺失/)
          assert.match(error.message, /修改连接/)
          // The raw backend envelope stays out of the message.
          assert.doesNotMatch(error.message, /1003/)
          assert.doesNotMatch(error.message, /Invalid or missing/)
          return true
        },
      )
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('a caller-aborted signal propagates unwrapped', async () => {
    const client = createMilocoClient({ baseUrl: slow.baseUrl, timeoutMs: 60_000 })
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await assert.rejects(
      () => client.get('/api/slow', { signal: controller.signal }),
      (error) => {
        assert.ok(!(error instanceof MilocoError))
        return true
      },
    )
  })
})
