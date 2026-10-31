#!/usr/bin/env node
// smoke.mjs —— Lead 的验收台：跟 server/mcp_server.mjs 走一遍真握手（不依赖 dsh 宿主）
// 用法: node smoke.mjs [--proxy http://127.0.0.1:7890]
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const env = { ...process.env }
const pi = args.indexOf('--proxy')
if (pi >= 0) env.X_PROXY = args[pi + 1]
env.X_DUTY_HOME = process.env.X_DUTY_HOME || join(dir, '.smoke-home')

const child = spawn(process.execPath, [join(dir, 'server', 'mcp_server.mjs')], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
let id = 0
child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { console.log('[non-json]', line.slice(0, 200)); continue }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d.toString('utf8')))
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id
  pending.set(myId, res)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)) } }, 60000)
})
const call = async (name, a = {}) => {
  const r = await rpc('tools/call', { name, arguments: a })
  const txt = r?.result?.content?.find?.((c) => c.type === 'text')?.text ?? JSON.stringify(r)
  let j; try { j = JSON.parse(txt) } catch { j = txt }
  return { isError: !!r?.error || !!r?.result?.isError, data: j }
}

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  console.log('initialize:', init.result ? 'ok' : JSON.stringify(init).slice(0, 200))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
  const list = await rpc('tools/list', {})
  const names = (list.result?.tools ?? []).map((t) => t.name)
  console.log('tools:', names.join(', ') || '(none)')
  const checks = [['x_status', {}], ['x_whoami', {}], ['x_search', { query: 'AI agent', limit: 3 }], ['x_tweet', { id: '2116383058735554610' }], ['x_growth', {}]]
  for (const [n, a] of checks) {
    if (!names.includes(n)) { console.log(n + ': SKIP(未注册)'); continue }
    try {
      const r = await call(n, a)
      const s = JSON.stringify(r.data)
      console.log(n + ': ' + (r.isError ? 'ERR ' : 'ok ') + s.slice(0, 260))
    } catch (e) { console.log(n + ': FAIL ' + e.message) }
  }
} catch (e) {
  console.log('FATAL', e.message)
} finally {
  child.stdin.end(); setTimeout(() => child.kill(), 1500)
}
