import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = dirname(fileURLToPath(import.meta.url))
const [tool, jsonArgs] = process.argv.slice(2)
const args = jsonArgs ? JSON.parse(jsonArgs) : {}
const env = { ...process.env, X_DUTY_HOME: join(dir, '.smoke-home') }
const child = spawn(process.execPath, [join(dir, 'server', 'mcp_server.mjs')], { cwd: dir, env })
let buf = ''; let id = 0; const pending = new Map()
child.stdout.on('data', (d) => {
  buf += d.toString('utf8'); let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
const rpc = (method, params) => new Promise((res) => {
  const myId = ++id; pending.set(myId, res)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
  setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ timeout: true }) } }, 60000)
})
const t0 = Date.now()
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
const r = await rpc('tools/call', { name: tool, arguments: args })
const txt = r?.result?.content?.[0]?.text ?? JSON.stringify(r)
console.log('[' + (Date.now() - t0) + 'ms] ' + tool + ' => ' + String(txt).slice(0, 900))
child.stdin.end(); setTimeout(() => process.exit(0), 300)
