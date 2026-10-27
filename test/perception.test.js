import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  normalizePerceptionLevel,
  parseUrgency,
  perceptionAllowed,
  PERCEPTION_LEVELS,
} from '../lib/perception.js'

describe('perception priority', () => {
  it('normalises levels', () => {
    assert.deepEqual(PERCEPTION_LEVELS, ['all', 'low', 'medium', 'high'])
    assert.equal(normalizePerceptionLevel('medium'), 'medium')
    assert.equal(normalizePerceptionLevel('HIGH'), 'high')
    assert.equal(normalizePerceptionLevel('nonsense'), 'all')
  })

  it('reads structured urgency fields', () => {
    assert.equal(parseUrgency({ urgency: 'high' }), 'high')
    assert.equal(parseUrgency({ priority: 'low' }), 'low')
    assert.equal(parseUrgency({ perception: { urgency: 'medium' } }), 'medium')
  })

  it('takes the highest urgency in a batch and handles ignore', () => {
    const message = [
      '事件优先级：low',
      '事件优先级：high',
      '事件优先级：medium',
    ].join('\n')
    assert.equal(parseUrgency({ message }), 'high')
    assert.equal(parseUrgency({ message: '事件优先级：ignore' }), 'ignore')
    assert.equal(parseUrgency({ message: '普通规则事件，没有优先级' }), '')
  })

  it('filters by the configured minimum', () => {
    assert.equal(perceptionAllowed('', 'high'), true)
    assert.equal(perceptionAllowed('ignore', 'all'), false)
    assert.equal(perceptionAllowed('low', 'all'), true)
    assert.equal(perceptionAllowed('low', 'medium'), false)
    assert.equal(perceptionAllowed('medium', 'medium'), true)
    assert.equal(perceptionAllowed('high', 'high'), true)
  })
})
