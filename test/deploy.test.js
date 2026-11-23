import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createDeployService, redactCommandArgs } from '../lib/deploy.js'

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

describe('deployment state recovery', () => {
  let workdir
  let logPath

  before(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-deploy-'))
    logPath = join(workdir, 'deploy.log')
  })
  after(async () => { await rm(workdir, { recursive: true, force: true }) })

  /**
   * Build a deploy service reading one log file.
   * @returns {any} The service.
   */
  function service() {
    return createDeployService({
      config: {
        home: workdir,
        deploy: { logPath },
      },
      logger: { info() {}, warn() {} },
    })
  }

  const start = '=== dsh-miloco-bridge: 一键部署 Miloco 开始 ==='

  it('reports nothing when no deployment ever ran', async () => {
    await writeFile(logPath, '', 'utf8')
    const state = service().state()
    assert.equal(state.step, 'idle')
    assert.equal(state.error, '')
  })

  it('recovers the failure reason of the last run', async () => {
    await writeFile(logPath, [
      start,
      '[x] 1/4 环境检查',
      '[x] 部署异常：Miloco release 安装器 prepare 返回 1',
      '',
    ].join('\n'), 'utf8')
    const state = service().state()
    assert.equal(state.step, 'failed')
    assert.equal(state.exitCode, 1)
    assert.match(state.error, /prepare 返回 1/)
  })

  it('ignores the failure of an earlier run when a newer one started', async () => {
    await writeFile(logPath, [
      start,
      '[x] 部署异常：第一次失败了',
      start,
      '[x] 2/4 安装核心组件',
      '',
    ].join('\n'), 'utf8')
    const state = service().state()
    // The newest run has no outcome yet: the old failure must not be reused.
    assert.notEqual(state.step, 'failed')
    assert.doesNotMatch(state.error ?? '', /第一次失败了/)
  })

  it('reports a completed deployment', async () => {
    await writeFile(logPath, [
      start,
      '[x] === 部署完成 ===',
      '',
    ].join('\n'), 'utf8')
    const state = service().state()
    assert.equal(state.step, 'done')
    assert.equal(state.exitCode, 0)
  })
})
