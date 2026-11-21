import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createPushService, sessionIdForMilocoKey } from '../lib/push.js'
import { createOverlay } from '../lib/overlay.js'
import { createStateStore, noteSession, readPushLog, readSessions } from '../lib/state.js'
import { createFakeSessionController, invoke } from './helpers.js'

let workdir
before(async () => { workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-push-')) })
after(async () => { await rm(workdir, { recursive: true, force: true }) })

/**
 * Build a push service with a fresh overlay/state pair.
 * @param {{existing?: string[], target?: string, mode?: 'archive'|'session', provider?: string, model?: string, token?: string, waitForResult?: boolean, review?: string, agentFollowup?: boolean, agentError?: boolean, home?: any}} [options] - Fixture options.
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

  const fake = createFakeSessionController({
    existing: options.existing ?? [],
    agentFollowup: options.agentFollowup === true,
    agentError: options.agentError === true,
  })
  const flushed = []
  const ctx = {
    logger: { info() {}, warn() {} },
    sessionController: fake.controller,
    sandboxPolicy: { workspaceRoot: '/tmp' },
    webServer: { register() { return () => {} } },
    effect() {},
    on: fake.on,
    get(name) {
      if (name === 'sessions') {
        return { flush: async session => { flushed.push(session); return true } }
      }
      return undefined
    },
  }
  const config = {
    cwd: '/tmp',
    home: workdir,
    push: {
      enabled: true,
      path: '/miloco/webhook',
      token: '',
      waitForResult: options.waitForResult === true,
      target: { mode: options.mode ?? 'session', sessionId: '', agentPreset: 'miloco' },
      model: { provider: '', model: '', reasoningEffort: '' },
    },
  }
  const service = createPushService({
    ctx,
    config,
    logger: ctx.logger,
    overlay,
    state,
    home: options.home,
    agentPreset: 'miloco',
    activity: {
      last: async () => (await readSessions(state)).last,
      note: async id => noteSession(state, id),
      clear: async () => {},
    },
  })
  return { service, fake, overlay, state, ctx, flushed }
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

describe('folded delivery', () => {
  it('delivers through the agent channel with a miloco-push source', async () => {
    const { service, fake, flushed } = await fixture({
      existing: ['s1'],
      target: 's1',
      agentFollowup: true,
    })
    const result = await service.deliver({ message: '厨房灯已打开', title: '客厅灯' })
    assert.equal(result.sessionId, 's1')
    assert.equal(result.folded, true)

    const followup = fake.followups.at(-1)
    assert.ok(followup)
    assert.equal(followup.sessionId, 's1')
    assert.equal(followup.message.role, 'user')
    assert.equal(followup.message.content[0].text, '厨房灯已打开')
    assert.equal(followup.message.source.kind, 'miloco-push')
    assert.equal(followup.message.source.form, 'notice')
    assert.equal(followup.message.source.summary, '客厅灯')
    assert.ok(followup.message.id)

    // The folded channel replaces the ordinary prompt path.
    assert.ok(!fake.calls.some(call => call[0] === 'prompt'))
    assert.equal(flushed.length, 1)
  })

  it('summarises the first body line when the push has no title', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      agentFollowup: true,
    })
    await service.deliver({ message: '有人按了门铃\n门口摄像头' })
    const followup = fake.followups.at(-1)
    assert.equal(followup.message.source.summary, '有人按了门铃')
  })

  it('truncates a long summary to 120 characters', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      agentFollowup: true,
    })
    await service.deliver({ message: 'x'.repeat(400) })
    const followup = fake.followups.at(-1)
    assert.equal(followup.message.source.summary.length, 120)
  })

  it('falls back to the ordinary prompt when the agent cannot be resolved', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
      agentError: true,
    })
    const result = await service.deliver({ message: 'hello' })
    assert.equal(result.folded, false)
    assert.ok(fake.calls.some(call => call[0] === 'prompt'))
    assert.equal(fake.followups.length, 0)
  })

  it('falls back to the ordinary prompt when the host has no agent channel', async () => {
    const { service, fake } = await fixture({
      existing: ['s1'],
      target: 's1',
    })
    const result = await service.deliver({ message: 'hello' })
    assert.equal(result.folded, false)
    assert.ok(fake.calls.some(call => call[0] === 'prompt'))
  })

  it('delivers into the household workspace directory', async () => {
    const homeDir = join(workdir, 'home-workspace')
    const { service, fake } = await fixture({
      existing: [],
      target: 'missing',
      agentFollowup: true,
      home: { dir: homeDir, ensure: async () => ({ path: homeDir, workspaceId: 'ws', title: 't', agentPreset: 'miloco' }) },
    })
    await service.deliver({ message: 'hello' })
    const created = fake.requests.find(request => request.sessionId !== undefined)
    // A session created for a push works in the household workspace directory.
    assert.equal(created?.cwd, homeDir)
  })
})

describe('target modes', () => {
  it('archive mode creates the dedicated session with the household cwd and preset', async () => {
    const homeDir = join(workdir, `archive-home-${Math.random().toString(16).slice(2)}`)
    const { service, fake, state } = await fixture({
      mode: 'archive',
      home: {
        dir: homeDir,
        ensure: async () => ({ path: homeDir, workspaceId: 'ws', title: '家庭助手', agentPreset: 'miloco' }),
      },
    })
    const first = await service.deliver({ message: '有人按门铃', title: '门口' })
    assert.equal(first.sessionId, 'miloco-archive')
    assert.equal(first.source, 'archive')

    const created = fake.requests.filter(request => request.sessionId === 'miloco-archive')
    assert.equal(created.length, 1)
    assert.equal(created[0].cwd, homeDir)
    assert.equal(created[0].agentPreset, 'miloco')
    assert.ok(fake.calls.some(call => call[0] === 'rename'
      && call[1] === 'miloco-archive' && call[2] === 'Miloco 推送归档'))

    const log = await readPushLog(state)
    assert.equal(log[0].sessionId, 'miloco-archive')
    assert.equal(log[0].status, 'ok')

    const second = await service.deliver({ message: '第二次' })
    assert.equal(second.sessionId, 'miloco-archive')
    assert.equal(fake.requests.filter(request => request.sessionId === 'miloco-archive').length, 1)
  })

  it('session mode keeps the last-Miloco fallback', async () => {
    const { service } = await fixture({ mode: 'session', existing: ['last-session'], review: 'last-session' })
    const result = await service.deliver({ message: 'hello' })
    assert.equal(result.sessionId, 'last-session')
    assert.equal(result.source, 'last-miloco-session')
  })

  it('the overlay mode wins over the static config', async () => {
    const { service, overlay } = await fixture({ mode: 'session', existing: ['s1'], target: 's1' })
    await overlay.write({ push: { target: { mode: 'archive' } } })
    const result = await service.deliver({ message: 'hello' })
    assert.equal(result.sessionId, 'miloco-archive')
    assert.equal(result.source, 'archive')
  })

  it('records a failed delivery in the push log', async () => {
    const { service, fake, state } = await fixture({ mode: 'session', existing: ['s1'], target: 's1' })
    fake.controller.onPrompt(() => { throw new Error('prompt down') })
    await assert.rejects(service.deliver({ message: 'hello' }), /prompt down/)
    const log = await readPushLog(state)
    assert.equal(log[0].status, 'error')
    assert.equal(log[0].sessionId, 's1')
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
