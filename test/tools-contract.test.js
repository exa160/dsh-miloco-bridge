import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createMilocoTools } from '../lib/tools.js'

const DEVICES = [
  { did: 'light-1', name: '吸顶灯', room_name: '客厅', online: true },
  { did: 'light-2', name: '台灯', room_name: '书房', online: true },
]

function harness() {
  const calls = []
  const client = {
    endpoint: async () => ({ baseUrl: 'http://miloco.test', token: '', home: '/tmp' }),
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: opts.query ?? null, body: opts.body ?? null })
      if (method === 'GET' && path === '/api/miot/device_list') return DEVICES
      return {}
    },
    async postMultipart(path, opts = {}) {
      calls.push({
        method: 'POST',
        path,
        multipart: true,
        fields: opts.fields ?? null,
        files: (opts.files ?? []).map(file => file.field),
      })
      return {}
    },
  }
  const tools = createMilocoTools({ client, readOnly: false })
  return {
    calls,
    tool: name => {
      const found = tools.find(entry => entry.name === name)
      assert.ok(found, `missing tool ${name}`)
      return found
    },
  }
}

describe('Miloco v2 write contracts', () => {
  it('creates a task placeholder with task_id/description only', async () => {
    const { calls, tool } = harness()
    await tool('miloco_task_create').execute({
      task_id: 'living_room_tidy',
      description: '整理客厅杂物',
      lifecycle: 'temporary',
      expires_at: '2026-11-01T00:00:00+08:00',
    })
    assert.deepEqual(calls[0], {
      method: 'POST',
      path: '/api/tasks',
      query: null,
      body: {
        task_id: 'living_room_tidy',
        description: '整理客厅杂物',
        lifecycle: 'temporary',
        expires_at: '2026-11-01T00:00:00+08:00',
      },
    })
  })

  it('rejects task ids with hyphens and empty descriptions early', async () => {
    const { tool } = harness()
    await assert.rejects(
      () => tool('miloco_task_create').execute({ task_id: 'living-room', description: 'x' }),
      /task_id 必须匹配/,
    )
    await assert.rejects(
      () => tool('miloco_task_create').execute({ task_id: 'living_room', description: '' }),
      /description/,
    )
  })

  it('initializes a structured record on an existing task', async () => {
    const { calls, tool } = harness()
    await tool('miloco_task_record_init').execute({
      task_id: 'drink_water',
      kind: 'progress',
      content: { target: 8, unit: '杯', window: 'day' },
    })
    assert.equal(calls[0].path, '/api/tasks/drink_water/record')
    assert.deepEqual(calls[0].body, {
      kind: 'progress',
      content: { target: 8, unit: '杯', window: 'day' },
    })
  })

  it('requires the mandatory progress fields', async () => {
    const { tool } = harness()
    await assert.rejects(
      () => tool('miloco_task_record_init').execute({
        task_id: 'drink_water',
        kind: 'progress',
        content: { target: 8 },
      }),
      /content.unit/,
    )
  })

  it('posts a structured rule instead of natural-language content', async () => {
    const { calls, tool } = harness()
    await tool('miloco_rule_create').execute({
      name: '客厅有人开灯',
      task_id: 'living_room_presence',
      condition: { perceive_device_ids: ['camera-1'], query: '客厅有人' },
      mode: 'event',
      actions: [{ did: 'light-1', iid: 'prop.2.1', value: true }],
      action_descriptions: ['客厅有人，已开灯'],
    })
    const body = calls[0].body
    assert.equal(calls[0].path, '/api/rules')
    assert.equal(body.content, undefined)
    assert.deepEqual(body.condition, { perceive_device_ids: ['camera-1'], query: '客厅有人' })
    assert.equal(body.mode, 'event')
    assert.deepEqual(body.actions, [{ did: 'light-1', iid: 'prop.2.1', value: true }])
  })

  it('validates rule condition and direction/mode consistency', async () => {
    const { tool } = harness()
    await assert.rejects(
      () => tool('miloco_rule_create').execute({
        name: 'x',
        task_id: 't',
        condition: { perceive_device_ids: [], query: '有人' },
      }),
      /perceive_device_ids/,
    )
    await assert.rejects(
      () => tool('miloco_rule_create').execute({
        name: 'x',
        task_id: 't',
        condition: { perceive_device_ids: ['camera-1'], query: '有人' },
        mode: 'state',
        direction: 'enter',
      }),
      /mode=event/,
    )
  })
})

describe('read and auxiliary write contracts', () => {
  it('filters devices locally without sending an unsupported room query', async () => {
    const { calls, tool } = harness()
    const result = JSON.parse(await tool('miloco_device_list').execute({ room: '客厅' }))
    assert.equal(calls[0].query, null)
    assert.deepEqual(result.map(device => device.did), ['light-1'])
  })

  it('keeps the device control enum and body shape aligned', async () => {
    const { calls, tool } = harness()
    await tool('miloco_device_control').execute({
      did: 'light-1',
      type: 'set_property',
      iid: 'prop.2.1',
      value: 'true',
    })
    assert.deepEqual(calls[0].body, { type: 'set_property', iid: 'prop.2.1', value: true })
    await assert.rejects(
      () => tool('miloco_device_control').execute({ did: 'light-1', type: 'toggle' }),
      /type 只能是/,
    )
  })

  it('requires a date on profile candidate writes', async () => {
    const { calls, tool } = harness()
    const op = { op: 'add', entry: { type: 'member_persona', content: '喜欢早起' } }
    await assert.rejects(
      () => tool('miloco_home_profile_candidate_write').execute({ ops: [op] }),
      /date/,
    )
    await tool('miloco_home_profile_candidate_write').execute({ ops: [{ ...op, date: '2026-10-28' }] })
    assert.deepEqual(calls[0].body, { ops: [{ ...op, date: '2026-10-28' }] })
  })

  it('commits the home profile without a JSON body', async () => {
    const { calls, tool } = harness()
    await tool('miloco_home_profile_commit').execute({})
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].path, '/api/home-profile/commit')
    assert.equal(calls[0].body, null)
  })

  it('deletes a rule by id', async () => {
    const { calls, tool } = harness()
    await tool('miloco_rule_delete').execute({ rule_id: 'rule-1' })
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(calls[0].path, '/api/rules/rule-1')
  })

  it('deletes a cron by id', async () => {
    const { calls, tool } = harness()
    await tool('miloco_cron_delete').execute({ cron_id: 'cron-1' })
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(calls[0].path, '/api/crons/cron-1')
  })

  it('uploads pet reference crops under the crops field', async () => {
    const { calls, tool } = harness()
    await tool('miloco_pet_reference_crops').execute({
      pet_id: 'pet-1',
      files: ['/tmp/a.jpg', '/tmp/b.jpg'],
      mode: 'append',
    })
    assert.equal(calls[0].path, '/api/identity/pets/pet-1/reference-crops')
    assert.deepEqual(calls[0].files, ['crops', 'crops'])
    assert.deepEqual(calls[0].fields, { mode: 'append' })
  })
})
