import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createHomeService } from '../lib/home.js'
import { resolveMilocoHomeDir } from '../lib/paths.js'

let workdir
before(async () => { workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-home-')) })
after(async () => { await rm(workdir, { recursive: true, force: true }) })

/**
 * Build a fake host context with an optional workspace registry.
 * @param {{registry?: boolean}} [options] - Fixture options.
 * @returns {any} The fake context and the registry call log.
 */
function fakeCtx(options = {}) {
  const registryCalls = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'workspaceRegistry' && options.registry !== false) {
        return {
          async create(path, title) {
            registryCalls.push([path, title])
            return { id: `ws-${registryCalls.length}`, path, title }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, registryCalls }
}

describe('resolveMilocoHomeDir', () => {
  it('uses the configured directory', () => {
    const dir = join(workdir, 'configured')
    assert.equal(resolveMilocoHomeDir(dir), dir)
  })

  it('expands a leading ~ in the configured directory', () => {
    assert.equal(resolveMilocoHomeDir('~/miloco-home'), join(homedir(), 'miloco-home'))
  })

  it('falls back to the plugin data directory', () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = join(workdir, 'dsh-home')
    try {
      assert.equal(
        resolveMilocoHomeDir(''),
        join(workdir, 'dsh-home', 'plugin-data', 'dsh-miloco-bridge', 'home'),
      )
      assert.equal(
        resolveMilocoHomeDir(undefined),
        join(workdir, 'dsh-home', 'plugin-data', 'dsh-miloco-bridge', 'home'),
      )
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

describe('home service', () => {
  it('creates the directory and registers the workspace', async () => {
    const dir = join(workdir, 'home-1')
    const { ctx, registryCalls } = fakeCtx()
    const home = createHomeService({
      ctx,
      config: { workspace: { dir, title: '家庭助手', agentPreset: 'miloco' } },
      logger: ctx.logger,
    })
    assert.equal(home.dir, dir)
    assert.equal(home.title, '家庭助手')
    assert.equal(home.agentPreset, 'miloco')
    assert.equal(home.workspaceId, '')

    const state = await home.ensure()
    assert.equal(state.path, dir)
    assert.equal(state.title, '家庭助手')
    assert.equal(state.agentPreset, 'miloco')
    assert.ok(state.workspaceId)
    assert.ok((await stat(dir)).isDirectory())
    assert.deepEqual(registryCalls, [[dir, '家庭助手']])
  })

  it('is idempotent', async () => {
    const dir = join(workdir, 'home-2')
    const { ctx, registryCalls } = fakeCtx()
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const first = await home.ensure()
    const second = await home.ensure()
    assert.equal(first.workspaceId, second.workspaceId)
    assert.equal(registryCalls.length, 1)
  })

  it('falls back to the defaults when the host has no workspace registry', async () => {
    const dir = join(workdir, 'home-3')
    const { ctx } = fakeCtx({ registry: false })
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.equal(state.workspaceId, '')
    assert.equal(state.title, 'Miloco 家庭助手')
    assert.equal(state.agentPreset, 'miloco')
    assert.ok((await stat(dir)).isDirectory())
  })

  it('survives a failing registry', async () => {
    const dir = join(workdir, 'home-4')
    const warnings = []
    const ctx = {
      logger: { info() {}, warn(message) { warnings.push(message) } },
      get() {
        return {
          async create() { throw new Error('registry down') },
        }
      },
    }
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.equal(state.workspaceId, '')
    assert.equal(warnings.length, 1)
  })

  it('accepts the workspace configuration under a `home` object too', async () => {
    const dir = join(workdir, 'home-5')
    const { ctx } = fakeCtx()
    const home = createHomeService({
      ctx,
      config: { home: { dir, title: '家', agentPreset: 'other' } },
      logger: ctx.logger,
    })
    assert.equal(home.dir, dir)
    assert.equal(home.title, '家')
    assert.equal(home.agentPreset, 'other')
  })
})
