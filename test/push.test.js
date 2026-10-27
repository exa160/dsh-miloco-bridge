import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createPushService, sessionIdForMilocoKey } from '../lib/push.js'
import { createOverlay } from '../lib/overlay.js'
import { createStateStore, noteSession, readSessions } from '../lib/state.js'
import { createFakeSessionController, invoke } from './helpers.js'

let workdir
before(async () => { workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-push-')) })
after(async () => { await rm(workdir, { recursive: true, force: true }) })

/**
 * Build a push service with a fresh overlay/state pair.
 * @param {{existing?: string[], target?: string, provider?: string, model?: string, token?: string, waitForResult?: boolean, review?: string}} [options] - Fixture options.
 * @returns {Promise<any>} Fixture.
 */
async function fixture(options = {}) {
  const overlay = createOverlay({ file: join(workdir, `overlay-${Math.random().toString(16).slice(2)}.json`) })
  await overlay.write({
    connection: { baseUrl: 'http://127.0.0.1:1', token: '' },
    push: {
      token: options.token ?? 'push-token',
      target: { sessionId: options.target ?? '' },
      model: {
        provider: options.provider ?? '',
        model: options.model ?? '',
        reasoningEffort: options.provider ? 'low' : '',
      },
      perception: { minLevel: options.perceptionLevel ?? 'all' },
    },
  })
  const state = createStateStore({ file: join(workdir, `state-${Math.random().toString(16).slice(2)}.json`) })
  if (options.review) await noteSession(state, options.review)

  const fake = createFakeSessionController({ existing: options.existing ?? [] })
  const ctx = {
    logger: { info() {}, warn() {} },
    sessionController: fake.controller,
    sandboxPolicy: { workspaceRoot: '/tmp' },
    webServer: { register() { return () => {} } },
    effect() {},
    on: fake.on,
  }
  const config = {
    cwd: '/tmp',
    home: workdir,
    push: {
      enabled: true,
      path: '/miloco/webhook',
      token: '',
      waitForResult: options.waitForResult === true,
      target: { sessionId: '', agentPreset: 'miloco' },
      model: { provider: '', model: '', reasoningEffort: '' },
    },
  }
  const service = createPushService({
    ctx,
    config,
    logger: ctx.logger,
    overlay,
    agentPreset: 'miloco',
    activity: {
      last: async () => (await readSessions(state)).last,
      note: async id => noteSession(state, id),
      clear: async () => {},
    },
  })
  return { service, fake, overlay, state, ctx }
}

describe('target semantics', () => {
  it('derives a stable id from the Miloco session key', () => {
    assert.equal(sessionIdForMilocoKey('agent:main:miloco'), 'miloco-agent-main-miloco')
  })

  it('empty target goes to the session that last touched Miloco', async () => {
    const { service, fake } = await fixture({ existing: ['last-session'], review: 'last-session' })
    const result = await service.deliver({ message: 'hello', sessionKey: 'agent:main:miloco' })
    assert.equal(result.sessionId, 'last-session')
    assert.equal(result.source, 'last-miloco-session')
    assert.deepEqual(fake.calls.find(call => call[0] === 'prompt')?.slice(0, 2), ['prompt', 'last-session'])
    assert.ok(!fake.calls.some(call => call[0] === 'selectModel'))
    assert.ok(!fake.calls.some(call => call[0] === 'create'))
  })

  it('configured session wins over the last Miloco session', async () => {
    const { service, fake } = await fixture({
      existing: ['last-session', 'chosen'],
      review: 'last-session',
      target: 'chosen',
    })
    const result = await service.deliver({ message: 'hello', sessionKey: 'k' })
    assert.equal(result.sessionId, 'chosen')
    assert.equal(result.source, 'configured')
  })

  it('falls back to the derived session and creates it with the Miloco preset', async () => {
    const { service, fake } = await fixture({ review: 'deleted-session' })
    const result = await service.deliver({ message: 'hello', sessionKey: 'agent:main:miloco' })
    assert.equal(result.sessionId, 'miloco-agent-main-miloco')
    const created = fake.calls.find(call => call[0] === 'create')
    assert.ok(created)
    assert.equal(created[1], 'miloco-agent-main-miloco')
    assert.equal(created[2], 'miloco')
  })

  it('configured model pins the conversation', async () => {
    const { service, fake } = await fixture({
      existing: ['chosen'],
      target: 'chosen',
      provider: 'prov',
      model: 'model-x',
    })
    await service.deliver({ message: 'hello' })
    const selected = fake.calls.find(call => call[0] === 'selectModel')
    assert.deepEqual(selected, ['selectModel', 'chosen', 'prov', 'model-x', 'low'])
  })

  it('empty model never touches selectModel', async () => {
    const { service, fake } = await fixture({ existing: ['chosen'], target: 'chosen' })
    await service.deliver({ message: 'hello' })
    assert.ok(!fake.calls.some(call => call[0] === 'selectModel'))
  })
})

describe('perception filter', () => {
  it('drops low-priority perception events before creating a turn', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      perceptionLevel: 'medium',
    })
    const result = await service.deliver({ message: '事件优先级：low', traceId: 'low-1' })
    assert.equal(result.status, 'filtered')
    assert.equal(result.filtered, true)
    assert.equal(result.urgency, 'low')
    assert.equal(result.minLevel, 'medium')
    assert.ok(!fake.calls.some(call => call[0] === 'prompt'))
  })

  it('delivers events at or above the level', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      perceptionLevel: 'medium',
    })
    const result = await service.deliver({ message: '事件优先级：high', traceId: 'high-1' })
    assert.notEqual(result.status, 'filtered')
    assert.ok(fake.calls.some(call => call[0] === 'prompt'))
  })

  it('never filters events without an urgency (rules/tasks/conversation)', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      perceptionLevel: 'high',
    })
    const result = await service.deliver({ message: '规则触发：客厅有人，执行回家场景', traceId: 'rule-1' })
    assert.notEqual(result.status, 'filtered')
    assert.ok(fake.calls.some(call => call[0] === 'prompt'))
  })

  it('accepts structured urgency from the adapter', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      perceptionLevel: 'high',
    })
    const result = await service.deliver({ message: '感知事件', urgency: 'low', traceId: 'structured-1' })
    assert.equal(result.status, 'filtered')
    assert.ok(!fake.calls.some(call => call[0] === 'prompt'))
  })
})

describe('webhook', () => {
  it('fails closed without a token', async () => {
    const { service, overlay } = await fixture({ token: '' })
    await overlay.write({ connection: {}, push: { token: '', target: { sessionId: '' }, model: { provider: '', model: '', reasoningEffort: '' } } })
    const response = await invoke(service.handleWebhook, {
      headers: { authorization: 'Bearer anything' },
      body: { action: 'agent', payload: { message: 'x' } },
    })
    assert.equal(response.status, 503)
  })

  it('rejects a wrong bearer token', async () => {
    const { service } = await fixture({ token: 'right' })
    const response = await invoke(service.handleWebhook, {
      headers: { authorization: 'Bearer wrong' },
      body: { action: 'agent', payload: { message: 'x' } },
    })
    assert.equal(response.status, 401)
  })

  it('accepts the overlay push token', async () => {
    const { service, fake } = await fixture({ token: 'right', existing: ['s1'], target: 's1' })
    const response = await invoke(service.handleWebhook, {
      headers: { authorization: 'Bearer right' },
      body: { action: 'agent', payload: { message: 'hello', traceId: 't-1' } },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.code, 0)
    assert.equal(response.body.data.sessionId, 's1')
    assert.ok(fake.calls.some(call => call[0] === 'prompt'))
  })

  it('waits for the matching turn and returns its reply', async () => {
    const { service, fake } = await fixture({ token: 't', existing: ['s1'], target: 's1', waitForResult: true })
    fake.controller.onPrompt(async (request, controller) => {
      queueMicrotask(() => {
        controller.emit({ id: 's1' }, { type: 'turn/start', data: { turn: 7 } })
        controller.emit({ id: 's1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
        controller.emit({ id: 's1' }, { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
      })
    })
    const result = await service.deliver({ message: 'hello', timeoutMs: 5_000 })
    assert.equal(result.status, 'ok')
    assert.equal(result.reply, 'done')
  })

  it('is idempotent for the same idempotency key', async () => {
    const { service, fake } = await fixture({ token: 't', existing: ['s1'], target: 's1' })
    const first = await service.deliver({ message: 'hello', idempotencyKey: 'same-key' })
    const second = await service.deliver({ message: 'hello', idempotencyKey: 'same-key' })
    assert.equal(second.idempotent, true)
    assert.equal(second.runId, first.runId)
    assert.equal(fake.calls.filter(call => call[0] === 'prompt').length, 1)
  })

  it('acknowledges reset_sessions', async () => {
    const { service } = await fixture({ token: 't' })
    const response = await invoke(service.handleWebhook, {
      headers: { authorization: 'Bearer t' },
      body: { action: 'reset_sessions', payload: { sessionKeys: ['agent:main:miloco'] } },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.data.cleared, ['miloco-agent-main-miloco'])
  })

  it('handles get_trace without leaking unknown data', async () => {
    const { service } = await fixture({ token: 't' })
    const response = await invoke(service.handleWebhook, {
      headers: { authorization: 'Bearer t' },
      body: { action: 'get_trace', payload: { runId: 'nope' } },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body.data.status, 'unknown')
  })
})
