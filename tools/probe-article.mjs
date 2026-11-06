import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = dirname(fileURLToPath(import.meta.url))
const env = { ...process.env, X_DUTY_HOME: 'F:/dsh-home/x-duty' }
const child = spawn(process.execPath, [join(dir, '..', 'server', 'mcp_server.mjs')], { cwd: join(dir, '..'), env })
let buf = ''; let id = 0; const pending = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString('utf8'); let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d.toString('utf8').slice(0, 400)))
const rpc = (method, params, ms) => new Promise((res) => {
  const myId = ++id; pending.set(myId, res)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ timeout: true }) } }, ms || 45000)
})
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p', version: '0' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
console.log('status:', JSON.stringify(await rpc('tools/call', { name: 'x_status', arguments: {} })).slice(0, 200))
const t0 = Date.now()
const r = await rpc('tools/call', { name: 'x_article', arguments: { title: '测试文章（草稿链路）', markdown: '# 测试文章（草稿链路）\n\n通过 MCP 建的草稿。\n', publish: false, confirm: true } }, 90000)
console.log('article(' + (Date.now()-t0) + 'ms):', JSON.stringify(r).slice(0, 500))
child.stdin.end(); setTimeout(() => process.exit(0), 300)
