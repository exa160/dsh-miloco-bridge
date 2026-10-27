#!/usr/bin/env node
/**
 * 只读自检脚本：直接调用插件里的 HTTP 客户端，验证若干**只读**接口。
 *
 * ⚠️ 这里只跑读接口（设备清单 / SPEC / 状态 / 场景 / 感知日志 / 规则 / 任务 /
 * 成员 / 档案 / 状态 / token 用量）。**不会**控制任何设备、不会触发场景、
 * 不会推送通知、不会创建规则或任务。
 *
 * 用法：node tools/verify-readonly.mjs [baseUrl]
 */
import { createMilocoClient } from '../lib/miloco-client.js'

const baseUrl = process.argv[2] || process.env.MILOCO_BASE_URL || ''
const token = process.env.MILOCO_TOKEN || ''
const client = createMilocoClient({ ...(baseUrl ? { baseUrl } : {}), ...(token ? { token } : {}) })

/** @type {{name: string, run: () => Promise<any>}[]} */
const probes = [
  { name: 'admin/status', run: () => client.get('/api/admin/status') },
  { name: 'perception/engine/status', run: () => client.get('/api/perception/engine/status') },
  { name: 'miot/device_list', run: () => client.get('/api/miot/device_list') },
  { name: 'miot/home', run: () => client.get('/api/miot/home') },
  { name: 'miot/camera_list', run: () => client.get('/api/miot/camera_list') },
  { name: 'miot/user_info', run: () => client.get('/api/miot/user_info') },
  { name: 'miot/login_status', run: () => client.get('/api/miot/login_status') },
  { name: 'miot/device_history', run: () => client.get('/api/miot/device_history') },
  { name: 'miot/scope/cameras', run: () => client.get('/api/miot/scope/cameras') },
  { name: 'perception/devices', run: () => client.get('/api/perception/devices') },
  { name: 'perception/logs', run: () => client.get('/api/perception/logs', { query: { limit: 3 } }) },
  { name: 'events', run: () => client.get('/api/events', { query: { limit: 2 } }) },
  { name: 'rules', run: () => client.get('/api/rules') },
  { name: 'rules/logs', run: () => client.get('/api/rules/logs') },
  { name: 'tasks', run: () => client.get('/api/tasks') },
  { name: 'tasks/summary', run: () => client.get('/api/tasks/summary') },
  { name: 'crons', run: () => client.get('/api/crons') },
  { name: 'identity/persons', run: () => client.get('/api/identity/persons') },
  { name: 'identity/pets', run: () => client.get('/api/identity/pets') },
  { name: 'home-profile/entries', run: () => client.get('/api/home-profile/entries') },
  { name: 'home-profile/rendered', run: () => client.get('/api/home-profile/rendered') },
  { name: 'admin/token-usage', run: () => client.get('/api/admin/token-usage', { query: { limit: 3 } }) },
  { name: 'actions', run: () => client.get('/api/actions', { query: { limit: 2 } }) },
  { name: 'agent_runs', run: () => client.get('/api/agent_runs', { query: { limit: 2 } }) },
]

/**
 * 打印一个值的简短摘要。
 * @param {any} value - 待摘要的值。
 * @returns {string} 摘要文本。
 */
function summarize(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') return `object{${Object.keys(value).slice(0, 8).join(', ')}}`
  return String(value)
}

const endpoint = await client.endpoint()
console.log(`后端：${endpoint.baseUrl}  token：${endpoint.token ? '已配置' : '缺失'}`)
console.log(`家目录：${endpoint.home}\n`)

let failures = 0
for (const probe of probes) {
  const started = Date.now()
  try {
    const value = await probe.run()
    console.log(`✓ ${probe.name.padEnd(28)} ${String(Date.now() - started).padStart(5)}ms  ${summarize(value)}`)
  } catch (error) {
    failures += 1
    console.log(`✗ ${probe.name.padEnd(28)} ${String(Date.now() - started).padStart(5)}ms  ${error.message}`)
  }
}

console.log(`\n${probes.length - failures}/${probes.length} 个只读接口通过。`)
process.exit(failures === 0 ? 0 : 1)
