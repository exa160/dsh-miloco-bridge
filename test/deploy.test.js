import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { redactCommandArgs } from '../lib/deploy.js'

describe('deployment log safety', () => {
  it('masks bearer tokens in command logs', () => {
    assert.deepEqual(
      redactCommandArgs(['config', 'set', 'agent.auth_bearer', 'super-secret']),
      ['config', 'set', 'agent.auth_bearer', '<redacted>'],
    )
    assert.deepEqual(
      redactCommandArgs(['--token', 'super-secret', '--verbose']),
      ['--token', '<redacted>', '--verbose'],
    )
    assert.deepEqual(
      redactCommandArgs(['service', 'start']),
      ['service', 'start'],
    )
  })
})
