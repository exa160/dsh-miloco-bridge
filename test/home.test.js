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
 * Build a fake host context with a workspace registry.
 * @param {{registry?: boolean, failing?: boolean, listFails?: boolean}} [options] - Fixture options.
 * @returns {any} The fake context, registry call log and registry items.
 */
function fakeCtx(options = {}) {
  const calls = []
  const items = []
  const ctx = {
    logger: {
      info() {},
      warn(message) { calls.push(['warn', message]) },
    },
    get(name) {
      if (name !== 'workspaceRegistry' || options.registry === false) return undefined
      return {
        async create(path, title) {
          calls.push(['create', path, title])
          if (options.failing) throw new Error('registry down')
          const found = items.find(item => item.path === path)
          if (found) return found
          const workspace = {
            id: `ws-${items.length + 1}`,
            path,
            title,
            async setTitle(next) {
              calls.push(['setTitle', this.id, next])
              this.title = next
            },
          }
          items.push(workspace)
          return workspace
        },
        list() {
          if (options.listFails) throw new Error('list down')
          return items
        },
        async insertBefore(id, beforeId) {
          calls.push(['insertBefore', id, beforeId])
        },
      }
    },
  }
  return { ctx, calls, items }
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
    const { ctx, calls } = fakeCtx()
    const home = createHomeService({
      ctx,
      config: { workspace: { dir, title: '家庭助手', agentPreset: 'miloco' } },
      logger: ctx.logger,
    })
    assert.equal(home.dir, dir)
    assert.equal(home.dirSource, 'config')
    assert.equal(home.title, '家庭助手')
    assert.equal(home.workspaceId, '')

    const state = await home.ensure()
    assert.equal(state.path, dir)
    assert.equal(state.title, '家庭助手')
    assert.equal(state.dirSource, 'config')
    assert.ok(state.workspaceId)
    assert.ok((await stat(dir)).isDirectory())
    assert.deepEqual(calls.filter(call => call[0] === 'create'), [['create', dir, '家庭助手']])
  })

  it('uses the overlay directory over the static config', async () => {
    const dir = join(workdir, 'home-overlay')
    const { ctx } = fakeCtx()
    const home = createHomeService({
      ctx,
      config: { workspace: { dir: join(workdir, 'ignored') } },
      overlay: { current: async () => ({ home: { dir }, push: {} }) },
      logger: ctx.logger,
    })
    const state = await home.ensure()
    assert.equal(state.path, dir)
    assert.equal(state.dirSource, 'overlay')
  })

  it('is idempotent and only retitles a renamed workspace', async () => {
    const dir = join(workdir, 'home-2')
    const { ctx, calls } = fakeCtx()
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const first = await home.ensure()
    const second = await home.ensure()
    assert.equal(first.workspaceId, second.workspaceId)
    assert.equal(calls.filter(call => call[0] === 'create').length, 1)
  })

  it('re-registers the workspace after the user deletes it', async () => {
    const dir = join(workdir, 'home-2c')
    const { ctx, items, calls } = fakeCtx()
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const first = await home.ensure()
    assert.equal(first.workspaceId, 'ws-1')

    // Simulate deleting the household workspace from the sidebar while another
    // workspace remains registered.
    items.splice(0, items.length, { id: 'ws-keep', path: '/tmp/keep', title: '保留' })
    const second = await home.ensure()
    assert.notEqual(second.workspaceId, first.workspaceId)
    assert.equal(second.workspaceId, 'ws-2')
    assert.equal(calls.filter(call => call[0] === 'create').length, 2)
    assert.ok(items.some(item => item.id === second.workspaceId && item.path === dir))
  })

  it('applies the configured title to an existing workspace', async () => {
    const dir = join(workdir, 'home-2b')
    const { ctx, items, calls } = fakeCtx()
    items.push({
      id: 'ws-old',
      path: dir,
      title: '旧标题',
      async setTitle(next) {
        calls.push(['setTitle', this.id, next])
        this.title = next
      },
    })
    const home = createHomeService({
      ctx,
      config: { workspace: { dir, title: '家庭助手' } },
      logger: ctx.logger,
    })
    const state = await home.ensure()
    assert.equal(state.workspaceId, 'ws-old')
    assert.ok(calls.some(call => call[0] === 'setTitle' && call[2] === '家庭助手'))
  })

  it('moves the household workspace before the first other workspace', async () => {
    const dir = join(workdir, 'home-3')
    const { ctx, items, calls } = fakeCtx()
    items.push({ id: 'ws-other', path: '/tmp/other', title: '工作' })
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.equal(state.workspaceId, 'ws-2')
    assert.deepEqual(calls.find(call => call[0] === 'insertBefore'), ['insertBefore', 'ws-2', 'ws-other'])
  })

  it('re-pins the household workspace when another workspace moves ahead', async () => {
    const dir = join(workdir, 'home-3b')
    const { ctx, items, calls } = fakeCtx()
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.ok(state.workspaceId)
    // Nothing to pin while the household workspace is alone.
    assert.equal(calls.some(call => call[0] === 'insertBefore'), false)

    items.unshift({ id: 'ws-other', path: '/tmp/other-3b', title: '工作' })
    await home.ensure()

    assert.deepEqual(
      calls.filter(call => call[0] === 'insertBefore'),
      [['insertBefore', state.workspaceId, 'ws-other']],
    )
  })

  it('falls back to the defaults when the host has no workspace registry', async () => {
    const dir = join(workdir, 'home-4')
    const { ctx } = fakeCtx({ registry: false })
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.equal(state.workspaceId, '')
    assert.equal(state.title, '家庭助手')
    assert.equal(state.agentPreset, 'miloco')
    assert.ok((await stat(dir)).isDirectory())
  })

  it('survives a failing registry', async () => {
    const dir = join(workdir, 'home-5')
    const { ctx, calls } = fakeCtx({ failing: true })
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.equal(state.workspaceId, '')
    assert.ok(calls.some(call => call[0] === 'warn'))
  })

  it('warns instead of rejecting when the registry list throws', async () => {
    const dir = join(workdir, 'home-5b')
    const { ctx, calls } = fakeCtx({ listFails: true })
    const home = createHomeService({ ctx, config: { workspace: { dir } }, logger: ctx.logger })
    const state = await home.ensure()
    assert.ok(state.workspaceId)
    assert.ok(
      calls.some(call => call[0] === 'warn' && String(call[1]).includes('读取工作区列表失败')),
      'expected a warn about the failing list()',
    )
  })

  it('setDir writes the overlay and registers the new directory', async () => {
    const firstDir = join(workdir, 'home-6')
    const secondDir = join(workdir, 'home-7')
    const writes = []
    const { ctx, calls, items } = fakeCtx()
    const home = createHomeService({
      ctx,
      config: { workspace: { dir: firstDir } },
      overlay: {
        current: async () => ({ home: { dir: writes.at(-1)?.home?.dir ?? '' } }),
        write: async value => { writes.push(value) },
      },
      logger: ctx.logger,
    })
    const before = await home.ensure()
    const after = await home.setDir(secondDir)
    assert.equal(before.path, firstDir)
    assert.equal(after.path, secondDir)
    assert.notEqual(before.workspaceId, after.workspaceId)
    assert.deepEqual(writes.at(-1), { home: { dir: secondDir } })
    // The old registration is retained, not deleted.
    assert.equal(items.filter(item => item.path === firstDir).length, 1)
    assert.equal(items.filter(item => item.path === secondDir).length, 1)
    assert.ok(!calls.some(call => call[0] === 'delete'))
  })

  it('accepts the workspace configuration under a `home` object too', async () => {
    const dir = join(workdir, 'home-8')
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
