/**
 * lib/http.mjs —— 极简 HTTPS 客户端（支持 HTTP 代理 CONNECT），零依赖
 * ============================================================================
 * 为什么不用 fetch：Node 的全局 fetch（undici）默认不走 HTTP_PROXY，本机必须走 127.0.0.1:7890；
 * 也不引第三方库（插件零依赖）。这里只实现够用的部分：
 *   - TLS + SNI
 *   - 代理 CONNECT 隧道（http://user:pass@host:port）
 *   - HTTP/1.1 请求，Content-Length 或 chunked 分帧的响应
 * 不处理重定向、gzip、keep-alive（都靠 Connection: close + 不请求压缩）。
 * ============================================================================
 */
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'

function openTunnel(proxyUrl, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl)
    const sock = net.connect({ host: p.hostname, port: Number(p.port || 80) })
    sock.setTimeout(timeoutMs || 20000, () => sock.destroy(new Error('代理连接超时')))
    let buf = ''
    const onData = (d) => {
      buf += d.toString('latin1')
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      sock.removeListener('data', onData)
      sock.setTimeout(0)
      const statusLine = buf.slice(0, buf.indexOf('\r\n'))
      if (!/\s200\s/.test(statusLine)) {
        sock.destroy()
        return reject(new Error('代理 CONNECT 失败：' + statusLine))
      }
      resolve(sock)
    }
    sock.on('data', onData)
    sock.once('error', reject)
    const auth = p.username
      ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password || '')).toString('base64') + '\r\n'
      : ''
    sock.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n' + auth + '\r\n')
  })
}

function tlsOver(socket, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ socket, servername: host }, () => resolve(s))
    s.once('error', reject)
    s.setTimeout(timeoutMs || 30000, () => s.destroy(new Error('TLS 握手超时')))
  })
}

/**
 * 发一个 HTTPS 请求，返回 { status, headers, body(Buffer) }
 * @param {{host:string, port?:number, path:string, method?:string, headers?:object, body?:Buffer, proxyUrl?:string, timeoutMs?:number}} opts
 */
export async function requestRaw(opts) {
  const host = opts.host
  const port = opts.port || 443
  const timeoutMs = opts.timeoutMs || 30000
  const body = opts.body || Buffer.alloc(0)
  const headers = Object.assign({}, opts.headers || {})

  let socket
  if (opts.proxyUrl) {
    const raw = await openTunnel(opts.proxyUrl, host, port, timeoutMs)
    socket = await tlsOver(raw, host, timeoutMs)
  } else {
    socket = tls.connect({ host, port, servername: host })
  }

  return new Promise((resolve, reject) => {
    const lines = [opts.method || 'POST', opts.path, 'HTTP/1.1', 'Host: ' + host, 'Connection: close']
    const method = String(opts.method || 'POST').toUpperCase()
    if (!headers['Content-Length'] && !headers['content-length'] && (body.length || method !== 'GET')) headers['Content-Length'] = String(body.length)
    for (const [k, v] of Object.entries(headers)) lines.push(k + ': ' + v)

    let head = ''
    let buf = Buffer.alloc(0)
    let headersDone = false
    let done = false

    const decodeChunked = () => {
      const out = []
      let i = 0
      for (;;) {
        const eol = buf.indexOf('\r\n', i)
        if (eol < 0) return null
        const size = parseInt(buf.subarray(i, eol).toString('latin1'), 16)
        if (!Number.isFinite(size)) return null
        if (size === 0) return Buffer.concat(out)
        if (buf.length < eol + 4 + size) return null
        out.push(buf.subarray(eol + 2, eol + 2 + size))
        i = eol + 2 + size + 2
      }
    }

    const tryFinish = (fromEnd) => {
      if (done || !headersDone) return
      const status = Number((head.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0)
      const hdrs = {}
      for (const line of head.split('\r\n').slice(1)) {
        const i = line.indexOf(':')
        if (i > 0) hdrs[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
      }
      const chunked = /transfer-encoding:\s*chunked/i.test(head)
      const lenM = head.match(/content-length:\s*(\d+)/i)
      let out = null
      if (chunked) out = decodeChunked()
      else if (lenM) {
        const need = Number(lenM[1])
        if (buf.length >= need) out = buf.subarray(0, need)
      }
      if (out === null && fromEnd) out = chunked ? buf : buf
      if (out === null) return
      done = true
      socket.removeAllListeners('data')
      resolve({ status, headers: hdrs, body: out })
    }

    socket.on('data', (d) => {
      if (!headersDone) {
        buf = Buffer.concat([buf, d])
        const sep = buf.indexOf('\r\n\r\n')
        if (sep < 0) return
        head = buf.subarray(0, sep).toString('utf8')
        buf = Buffer.from(buf.subarray(sep + 4))
        headersDone = true
      } else {
        buf = Buffer.concat([buf, d])
      }
      tryFinish(false)
    })
    socket.on('end', () => tryFinish(true))
    socket.once('error', (e) => { if (!done) { done = true; try { socket.destroy() } catch {} ; reject(e) } })
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('请求超时')))
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (body.length) socket.write(body)
  })
}

/** 拿到一个 JSON 响应（解析失败时把文本塞进 errText） */
export async function requestJson(opts) {
  const r = await requestRaw(opts)
  let data = null
  const text = r.body.toString('utf8')
  try { data = JSON.parse(text) } catch { /* 保留文本 */ }
  return { status: r.status, headers: r.headers, data, text }
}
