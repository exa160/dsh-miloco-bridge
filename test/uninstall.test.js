import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { createUninstallService, UNINSTALL_CONFIRM } from '../lib/uninstall.js'
import { createOverlay } from '../lib/overlay.js'

let workdir
before(async () => { workdir = await mkdtemp(join(tmpdir(), 'dsh-miloco-uninstall-')) })
after(async () => { await rm(workdir, { recursive: true, force: true }) })

describe('uninstall', () => {
  it('requires the literal confirmation before doing anything', async () => {
    const calls = []
    const service = createUninstallService({
      config: { home: join(workdir, 'home'), deploy: { sourceDir: join(workdir, 'src') } },
      runner: async (...args) => { calls.push(args); return { code: 0, output: '' } },
    })
    await assert.rejects(
      () => service.run({ confirm: 'yes' }),
      /UNINSTALL/,
    )
    assert.equal(calls.length, 0)
  })

  it('refuses to delete data or source outside the allowed roots', async () => {
    const service = createUninstallService({
      config: { home: join(workdir, 'custom-home'), deploy: { sourceDir: join(workdir, 'custom-src') } },
      runner: async () => ({ code: 0, output: '' }),
    })
    await assert.rejects(
      () => service.run({ confirm: UNINSTALL_CONFIRM, removeData: true }),
      /拒绝删除自定义 MILOCO_HOME/,
    )
    await assert.rejects(
      () => service.run({ confirm: UNINSTALL_CONFIRM, removeSource: true }),
      /拒绝删除不在 DSH 数据目录下/,
    )
  })

  it('stops, removes the adapter, and clears connection/token', async () => {
    const home = join(workdir, 'miloco-home')
    const source = join(workdir, 'source')
    const adapter = join(home, 'agent_platform', 'dsh')
    await mkdir(adapter, { recursive: true })
    await writeFile(join(adapter, 'adapter.py'), 'x')
    await writeFile(join(home, 'supervisord.conf'), '[supervisord]\n')
    const overlayFile = join(workdir, 'overlay.json')
    const overlay = createOverlay({ file: overlayFile })
    await overlay.write({
      connection: { baseUrl: 'http://x', token: 'conn' },
      push: {
        token: 'push',
        target: { sessionId: 's1' },
        model: { provider: 'p', model: 'm', reasoningEffort: '' },
      },
    })
    const calls = []
    const service = createUninstallService({
      config: { home, deploy: { sourceDir: source } },
      overlay,
      unitPath: join(workdir, 'no-such-unit.service'),
      runner: async (command, args) => {
        calls.push([command, ...args])
        return { code: 0, output: '' }
      },
    })
    const result = await service.run({ confirm: UNINSTALL_CONFIRM })
    assert.equal(result.ok, true)
    assert.equal(result.removedAdapter, true)
    assert.equal(result.clearedConnection, true)
    assert.equal(existsSync(adapter), false)
    assert.ok(calls.some(call => call.includes('shutdown')))
    const saved = JSON.parse(await readFile(overlayFile, 'utf8'))
    assert.equal(saved.connection.baseUrl, '')
    assert.equal(saved.connection.token, '')
    assert.equal(saved.push.token, '')
    assert.equal(saved.push.target.sessionId, 's1')
  })
})
