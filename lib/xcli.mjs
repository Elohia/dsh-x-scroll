/**
 * lib/xcli.mjs —— 与 twitter-cli 打交道的**唯一**一层
 * ============================================================================
 * 这个文件只干四件事，别的都不管：
 *   ① 找二进制：显式配置 → X_TWITTER_BIN → 常见安装位置 → PATH
 *   ② 注入凭据：进程 env 或 HKCU\Environment（reg query 读），**只塞进子进程 env**
 *      —— 绝不打印、绝不落盘，报错信息里也替换成 ***
 *   ③ 探测代理：显式配置 / X_PROXY → TWITTER_PROXY → 127.0.0.1:7890 → :7892
 *      → HKCU Internet Settings；每个候选都做**真 TCP 探活**，全不通返回 {ok:false}，不抛
 *   ④ 统一执行：runTw(args) 起子进程、收 stdout、解析 --json、把 twitter-cli 的
 *      {ok,schema_version,data|error} 归一成 {ok,data} / {ok:false,error}
 *
 * 为什么单独一层：host（index.js）和 MCP server（server/mcp_server.mjs）都要取数，
 * 二进制路径 / 凭据 / 代理这三件事**只允许有一份实现**，否则两边迟早对不上。
 *
 * 只读：这里没有任何 post / like / reply / retweet / follow 的封装。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export const VERSION = '0.1.0'

const envInt = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/* ────────────────────────────── 小工具 ────────────────────────────── */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

const int = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tail = (s, n) => {
  const v = String(s ?? '')
  return v.length > n ? v.slice(-n) : v
}

/** 时间：能解析成日期就给 ISO，解析不了保留原字符串（twitter-cli 两种格式都给过） */
function isoOrRaw(s) {
  const raw = clean(s)
  if (!raw) return ''
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? raw : d.toISOString()
}

/* ────────────────────────────── 家目录与日志 ────────────────────────────── */

let logImpl = (msg) => {
  try { process.stderr.write(String(msg) + '\n') } catch { /* 无所谓 */ }
}

/**
 * 插件家目录：X_DUTY_HOME → $DSH_HOME/x-duty → ~/.dsh/x-duty
 * （和 host 那边 lib/state.mjs 的口径一致；这里不 import 它，避免 MCP 端被 host 依赖拖住）
 */
export function xHome() {
  const direct = clean(process.env.X_DUTY_HOME)
  if (direct) return direct
  const dsh = clean(process.env.DSH_HOME) || join(homedir(), '.dsh')
  return join(dsh, 'x-duty')
}

/**
 * 日志：只写"发生了什么"，**永不写凭据**。
 * 家目录可能只读（装进 node_modules 时），写不进去就算了 —— 不能因此让 server 挂掉。
 */
export function log(msg) {
  const line = new Date().toISOString() + '  ' + msg
  try {
    const dir = xHome()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'mcp.log'), line + '\n', 'utf8')
  } catch { /* 写不进去就算了 */ }
  try { logImpl(line) } catch { /* 无所谓 */ }
}

/* ────────────────────────────── 配置与缓存 ────────────────────────────── */

const state = {
  bin: null,          // { ok, bin, version, source, tried[], error }
  binAt: 0,
  proxy: null,        // { ok, url, source, report, candidates, error, at }
  proxyKey: '',
  cred: null,         // { ok, source, token, ct0, hasToken, hasCt0, error }
  configBin: '',
  configProxy: '',
}

/**
 * host（index.js）把 config.json 里的 twitterBin / proxy 从这里传进来；
 * **配置优先于环境变量**（设置页里填的就是用户自己选的）。
 */
export function configure(opts = {}) {
  if (opts.bin !== undefined) state.configBin = clean(opts.bin)
  if (opts.proxy !== undefined) state.configProxy = clean(opts.proxy)
  if (typeof opts.log === 'function') logImpl = opts.log
  state.bin = null
  state.binAt = 0
  state.proxy = null
  state.proxyKey = ''
  state.cred = null
}

/* ────────────────────────────── ① 找二进制 ────────────────────────────── */

/** 默认安装位置（全部从 home / 环境变量推导，不写死任何个人绝对路径） */
function defaultBinCandidates() {
  const home = homedir()
  const localAppData = clean(process.env.LOCALAPPDATA)
  const appData = clean(process.env.APPDATA)
  const out = []
  // pip / pipx / Python 的常规落点；Windows 上大小写不敏感
  out.push(join(home, '.local', 'bin', 'twitter.exe'))
  out.push(join(home, '.local', 'bin', 'twitter'))
  if (localAppData) {
    out.push(join(localAppData, 'pipx', 'pipx', 'venvs', 'twitter-cli', 'Scripts', 'twitter.exe'))
    out.push(join(localAppData, 'Programs', 'Python', 'Scripts', 'twitter.exe'))
  }
  if (appData) out.push(join(appData, 'Python', 'Scripts', 'twitter.exe'))
  return out
}

/** 在 PATH 里按名字找（自己拼，不额外起 where/which） */
function searchPath(names) {
  const path = clean(process.env.PATH)
  if (!path) return ''
  for (const dir of path.split(delimiter)) {
    const d = dir.trim()
    if (!d) continue
    for (const name of names) {
      const p = join(d, name)
      try { if (existsSync(p) && statSync(p).isFile()) return p } catch { /* 没权限就算了 */ }
    }
  }
  return ''
}

function isFile(p) {
  try { return Boolean(p) && existsSync(p) && statSync(p).isFile() } catch { return false }
}

/**
 * 解析二进制：{ ok, bin, version, source, tried[], error }
 * 顺序：设置页配置 → X_TWITTER_BIN → 默认安装位置 → PATH
 */
export async function resolveBin(opts = {}) {
  const now = Date.now()
  if (!opts.refresh && state.bin && now - state.binAt < 60000) return state.bin

  const tried = []
  const candidates = []
  const push = (p, source, strict) => {
    const v = clean(p)
    if (!v) return
    if (candidates.some((c) => c.path.toLowerCase() === v.toLowerCase())) return
    candidates.push({ path: v, source, strict: Boolean(strict) })
  }
  // 显式指定的（设置页 / 环境变量）**一律严格**：用户点名了哪个就用哪个，
  // 指错了要直接报出来，不能偷偷换成另一个二进制（否则排查时永远看不出是谁在跑）
  push(state.configBin, 'config', true)
  push(process.env.X_TWITTER_BIN, 'env:X_TWITTER_BIN', true)
  for (const p of defaultBinCandidates()) push(p, 'default', false)
  const fromPath = searchPath(['twitter.exe', 'twitter.cmd', 'twitter.bat', 'twitter'])
  if (fromPath) push(fromPath, 'path', false)

  for (const c of candidates) {
    const bad = (reason) => {
      tried.push({ path: c.path, source: c.source, ok: false, reason })
      if (!c.strict) return false
      state.bin = {
        ok: false,
        bin: '',
        version: '',
        source: c.source,
        tried,
        error: '你指定的 twitter-cli 用不了：' + c.path + '（' + reason + '）—— 改 X_TWITTER_BIN / 设置页里的 twitterBin，或清空它让插件自动找',
      }
      state.binAt = now
      log('twitter-cli：显式指定的路径不可用（' + c.path + '，' + reason + '）')
      return true
    }
    if (!isFile(c.path)) { if (bad('文件不存在')) return state.bin; continue }
    const version = await readVersion(c.path)
    if (!version) {
      // 文件在、但跑不起来（架构不对 / 装坏了）
      if (bad('跑不起来，--version 失败')) return state.bin
      continue
    }
    tried.push({ path: c.path, source: c.source, ok: true })
    state.bin = { ok: true, bin: c.path, version, source: c.source, tried }
    state.binAt = now
    log('twitter-cli：' + c.path + '（v' + version + '，来源 ' + c.source + '）')
    return state.bin
  }

  state.bin = {
    ok: false,
    bin: '',
    version: '',
    source: '',
    tried,
    error: '找不到 twitter-cli：请先装（pipx install twitter-cli），或用 X_TWITTER_BIN 指定可执行文件路径',
  }
  state.binAt = now
  log('twitter-cli：没找到（试过 ' + tried.length + ' 个位置）')
  return state.bin
}

/** 版本号：twitter --version 输出 'twitter.EXE, version 0.8.5'，只取 x.y.z */
async function readVersion(bin, timeoutMs) {
  const r = await execRaw(bin, ['--version'], { timeoutMs: timeoutMs || 20000 })
  const m = (r.stdout + '\n' + r.stderr).match(/(\d+\.\d+\.\d+)/)
  return m ? m[1] : ''
}

/* ────────────────────────────── ② 凭据 ────────────────────────────── */

const CRED_KEYS = ['TWITTER_AUTH_TOKEN', 'TWITTER_CT0']

/** 用 reg query 读 HKCU\Environment 里的一个值；读不到返回空串（**不打印任何值**） */
async function regRead(name, timeoutMs) {
  if (process.platform !== 'win32') return ''
  const r = await execRaw('reg', ['query', 'HKCU\\Environment', '/v', name], { timeoutMs: timeoutMs || 6000 })
  const lines = (r.stdout + '\n' + r.stderr).split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(new RegExp('^\\s*' + name + '\\s+REG_[A-Z_]+\\s+(.*)$'))
    if (!m) continue
    let v = m[1].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    return v.trim()
  }
  return ''
}

/**
 * 凭据：进程 env 优先，缺哪个去 HKCU\Environment 补哪个。
 * ⚠️ 返回里的 token/ct0 只用于注入子进程 env；上层只看 {ok, source, hasToken, hasCt0}。
 */
export async function resolveCredentials(opts = {}) {
  if (!opts.refresh && state.cred) return state.cred

  const fromEnv = {
    token: clean(process.env.TWITTER_AUTH_TOKEN),
    ct0: clean(process.env.TWITTER_CT0),
  }
  const cred = { ok: false, source: '', token: '', ct0: '', hasToken: false, hasCt0: false }

  if (fromEnv.token && fromEnv.ct0) {
    cred.source = 'env'
    cred.token = fromEnv.token
    cred.ct0 = fromEnv.ct0
  } else {
    const token = fromEnv.token || await regRead(CRED_KEYS[0], opts.timeoutMs)
    const ct0 = fromEnv.ct0 || await regRead(CRED_KEYS[1], opts.timeoutMs)
    cred.token = token
    cred.ct0 = ct0
    if (token && ct0) cred.source = 'registry'
    else if (token || ct0) cred.source = 'partial'
  }

  cred.hasToken = Boolean(cred.token)
  cred.hasCt0 = Boolean(cred.ct0)
  cred.ok = cred.hasToken && cred.hasCt0
  if (!cred.ok) {
    cred.error = '没有 TWITTER_AUTH_TOKEN / TWITTER_CT0：请在用户环境变量里设置（或让 twitter-cli 从浏览器读 cookie）'
  }
  state.cred = cred
  log('凭据：' + (cred.ok ? '已拿到（来源 ' + cred.source + '）' : '不完整（' + cred.source + '）'))
  return cred
}

/** 把已知凭据值从任意文本里抹掉（报错 / 日志都要过一遍） */
export function redact(text) {
  let out = String(text ?? '')
  const secrets = [state.cred && state.cred.token, state.cred && state.cred.ct0, process.env.TWITTER_AUTH_TOKEN, process.env.TWITTER_CT0]
  for (const s of secrets) {
    const v = String(s || '')
    if (v.length >= 6 && out.includes(v)) out = out.split(v).join('***')
  }
  out = out.replace(/(auth_token=)[^;\s"']+/gi, '$1***').replace(/(ct0=)[^;\s"']+/gi, '$1***')
  return out
}

/* ────────────────────────────── ③ 代理 ────────────────────────────── */

const PROXY_PROBE_MS = envInt('X_PROXY_PROBE_MS', 800)
const PROXY_CACHE_MS = envInt('X_PROXY_CACHE_MS', 60000)
const PROXY_FAIL_CACHE_MS = envInt('X_PROXY_FAIL_CACHE_MS', 10000)
const PROXY_AUTO_PORTS = [7890, 7892]   // 7890 主用；7892 只作回退（这台机器上是死的）
const DIRECT_VALUES = ['direct', 'none', 'off', 'no', 'noproxy', '直连']

/** '127.0.0.1:7890' / 'http://127.0.0.1:7890' / 'socks5://…' 都认 */
function parseProxy(raw) {
  let s = clean(raw)
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s
  let u
  try { u = new URL(s) } catch { return null }
  const scheme = u.protocol.replace(/:$/, '').toLowerCase()
  if (['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h'].indexOf(scheme) < 0) return null
  const port = u.port ? Number(u.port) : (scheme.indexOf('socks') === 0 ? 1080 : 80)
  if (!u.hostname || !Number.isFinite(port) || port <= 0 || port > 65535) return null
  const auth = u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : ''
  const hostPort = u.hostname + (u.port ? ':' + u.port : '')
  return {
    // 带 auth 的 url 只用于子进程 env；对外展示一律 displayUrl
    url: scheme + '://' + auth + hostPort,
    displayUrl: scheme + '://' + hostPort,
    host: u.hostname,
    port,
  }
}

/** 真 TCP 探活：连得上才算活（能不能出网由后续 status 暴露） */
function tcpAlive(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false
    const sock = connect({ host, port })
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch { /* 无所谓 */ }
      resolve(v)
    }
    sock.setTimeout(timeoutMs || PROXY_PROBE_MS)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/** 读 HKCU Internet Settings（系统代理）——读不到返回 null，绝不抛 */
async function readInternetSettings(timeoutMs) {
  if (process.platform !== 'win32') return null
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
  const r = await execRaw('reg', ['query', key], { timeoutMs: timeoutMs || 6000 })
  const map = {}
  for (const line of (r.stdout + '\n' + r.stderr).split(/\r?\n/)) {
    const m = line.match(/^\s{2,}([A-Za-z0-9_.]+)\s+REG_[A-Z_]+\s+(.*)$/)
    if (m) map[m[1]] = m[2].trim()
  }
  return Object.keys(map).length ? map : null
}

/** ProxyServer 可能是 'host:port'，也可能是 'http=…;https=…;socks=…' */
function proxyFromInternetSettings(map) {
  if (!map) return null
  if (String(map.ProxyEnable ?? '0').trim() === '0') return null
  const server = clean(map.ProxyServer)
  if (!server) return null
  if (server.indexOf('=') < 0) return server
  const parts = {}
  for (const seg of server.split(';')) {
    const i = seg.indexOf('=')
    if (i < 0) continue
    parts[seg.slice(0, i).trim().toLowerCase()] = seg.slice(i + 1).trim()
  }
  const httpish = parts.https || parts.http
  if (httpish) return httpish
  const socks = parts.socks5 || parts.socks
  return socks ? 'socks5://' + socks : null
}

/**
 * 解析代理。顺序（命中即用；**显式指定的一律严格**，连不上就报错，不偷偷换别的）：
 *   1. 设置页 config.proxy（strict）
 *   2. X_PROXY（strict —— "我指定了，你就用它"；连不上要让我知道，而不是悄悄走 7890）
 *   3. TWITTER_PROXY（twitter-cli 原生变量，宽松：死了继续往下找）
 *   4. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（宽松）
 *   5. 127.0.0.1:7890 → 127.0.0.1:7892（宽松）
 *   6. HKCU Internet Settings 里的系统代理（宽松）
 * 全不通 ⇒ { ok:false, error } —— **不抛异常**，让调用方决定怎么报。
 * 想直连（机器本来就在墙外）：把 proxy 写成 'direct'，或设 X_DIRECT=1。
 */
export async function resolveProxy(opts = {}) {
  const want = opts.explicit !== undefined ? clean(opts.explicit) : state.configProxy
  const key = want + '|' + (process.env.X_PROXY || '') + '|' + (process.env.TWITTER_PROXY || '')
  const now = Date.now()
  if (!opts.refresh && state.proxy && state.proxyKey === key && state.proxy.at) {
    const ttl = state.proxy.ok ? PROXY_CACHE_MS : PROXY_FAIL_CACHE_MS
    if (now - state.proxy.at < ttl) return state.proxy
  }

  const finish = (value) => {
    state.proxy = Object.assign({}, value, { at: Date.now() })
    state.proxyKey = key
    if (value.ok) log('代理：' + value.source + ' → ' + (value.report && value.report.url ? value.report.url : '(直连)'))
    else log('代理：没有可用的（试了 ' + value.candidates.length + ' 个候选）')
    return state.proxy
  }

  const directFlag = ['1', 'true', 'yes', 'on'].indexOf(clean(process.env.X_DIRECT).toLowerCase()) >= 0
  const isDirect = (v) => DIRECT_VALUES.indexOf(clean(v).toLowerCase()) >= 0
  if (directFlag || isDirect(want) || isDirect(process.env.X_PROXY)) {
    return finish({ ok: true, url: '', source: 'direct', report: { url: '', source: 'direct' }, candidates: [] })
  }

  const cands = []
  const add = (raw, source, strict) => {
    const p = parseProxy(raw)
    if (!p) return
    if (cands.some((c) => c.p.url === p.url)) return
    cands.push({ p, source, strict })
  }
  add(want, 'config', true)
  add(process.env.X_PROXY, 'env:X_PROXY', true)
  add(process.env.TWITTER_PROXY, 'env:TWITTER_PROXY', false)
  add(process.env.HTTPS_PROXY || process.env.https_proxy, 'env:HTTPS_PROXY', false)
  add(process.env.HTTP_PROXY || process.env.http_proxy, 'env:HTTP_PROXY', false)
  add(process.env.ALL_PROXY || process.env.all_proxy, 'env:ALL_PROXY', false)
  for (const port of PROXY_AUTO_PORTS) add('127.0.0.1:' + port, 'probe:' + port, false)
  const sysProxy = proxyFromInternetSettings(await readInternetSettings())
  add(sysProxy, 'registry', false)

  const results = []
  for (const c of cands) {
    const alive = await tcpAlive(c.p.host, c.p.port)
    results.push({ url: c.p.displayUrl, source: c.source, ok: alive, strict: c.strict })
    if (alive) {
      return finish({
        ok: true,
        url: c.p.url,
        source: c.source,
        report: { url: c.p.displayUrl, source: c.source },
        candidates: results,
      })
    }
    if (c.strict) {
      return finish({
        ok: false,
        url: '',
        source: c.source,
        report: { url: c.p.displayUrl, source: c.source },
        candidates: results,
        error: {
          code: 'proxy_unavailable',
          message: '你指定的代理连不上（' + c.p.displayUrl + '，来源 ' + c.source + '）—— 先启动代理软件，或改配置里的 proxy；想直连就把 proxy 设成 direct',
        },
      })
    }
  }

  return finish({
    ok: false,
    url: '',
    source: 'none',
    report: { url: '', source: 'none' },
    candidates: results,
    error: {
      code: 'proxy_unavailable',
      message: '没有可用的代理（自动探测 127.0.0.1:7890 / :7892 和系统代理都连不上）—— 先启动代理，或设 X_PROXY；想直连就把 proxy 设成 direct',
    },
  })
}

/* ────────────────────────────── 底层 spawn ────────────────────────────── */

const MAX_OUTPUT = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = envInt('X_CLI_TIMEOUT_MS', 120000)

/**
 * 起一个子进程并收完输出。**不解析 JSON、不注入凭据**（那是 runTw 的事），
 * 只给 --version / reg query 这类小命令用。
 */
function execRaw(cmd, args, opts) {
  const options = opts || {}
  const timeoutMs = options.timeoutMs || 15000
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(cmd, args, {
        env: options.env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: Boolean(options.shell),
      })
    } catch (e) {
      resolve({ stdout: '', stderr: String(e && e.message ? e.message : e), code: -1, error: true })
      return
    }
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const append = (s, chunk) => (s.length > MAX_OUTPUT ? s : s + chunk)
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已经死了 */ }
      done({ stdout, stderr, code: -1, timedOut: true })
    }, timeoutMs)
    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c) => { stdout = append(stdout, c) })
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (c) => { stderr = append(stderr, c) })
    }
    child.on('error', (e) => {
      done({ stdout, stderr: String(e && e.message ? e.message : e), code: -1, error: true })
    })
    child.on('close', (code) => {
      done({ stdout, stderr, code: code === null ? -1 : code })
    })
  })
}

/** 子进程 env：代理 + 凭据 + 杂项。凭据只在内存里拼，不落盘。 */
function childEnv(proxy, cred, extra) {
  const env = Object.assign({}, process.env, extra || {})
  const proxyKeys = [
    'TWITTER_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
  ]
  if (!proxy || !proxy.url) {
    // 直连 / 没代理：把父进程里可能残留的代理变量清掉，别让 curl 偷偷走上别的东西
    for (const k of proxyKeys) delete env[k]
  } else {
    env.TWITTER_PROXY = proxy.url
    env.HTTPS_PROXY = proxy.url
    env.HTTP_PROXY = proxy.url
    env.https_proxy = proxy.url
    env.http_proxy = proxy.url
  }
  if (cred && cred.token && cred.ct0) {
    env.TWITTER_AUTH_TOKEN = cred.token
    env.TWITTER_CT0 = cred.ct0
  }
  env.NO_COLOR = '1'
  env.CLICOLOR = '0'
  env.FORCE_COLOR = '0'
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  return env
}

/* ────────────────────────────── ④ runTw ────────────────────────────── */

/** 从 stdout 里抠 JSON（正常只吐一份；有杂音也能救回来） */
function parseStdout(stdout) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) return { value: undefined }
  const tries = [text]
  const i = text.indexOf('{')
  const j = text.lastIndexOf('}')
  if (i >= 0 && j > i) tries.push(text.slice(i, j + 1))
  for (const t of tries) {
    try { return { value: JSON.parse(t) } } catch { /* 下一个 */ }
  }
  return { value: undefined, text }
}

const normError = (code, message) => ({
  code: clean(code) || 'cli_error',
  message: redact(clean(message) || 'twitter-cli 报错'),
})

/**
 * 执行一条 twitter-cli 命令，**统一解析 --json**：
 *   成功 → { ok:true, data }
 *   失败 → { ok:false, error:{code,message} }   ← 不抛异常，上层决定怎么报
 * 找不到二进制 / 代理不可用 / 超时也走 ok:false，code 分别 cli_not_found / proxy_unavailable / timeout。
 *
 * opts: timeoutMs | proxyInfo | credInfo | refreshProxy | extraEnv | noProxy
 */
export async function runTw(args, opts) {
  const options = opts || {}
  const argv = Array.isArray(args) ? args.map(String) : []
  if (!argv.length) return { ok: false, error: normError('bad_request', 'runTw 需要至少一个子命令') }
  if (argv.indexOf('--json') < 0 && argv.indexOf('--yaml') < 0 && argv.indexOf('-c') < 0 && argv.indexOf('--compact') < 0) {
    // '--' 之后是位置参数，--json 必须插在它前面
    const dashDash = argv.indexOf('--')
    if (dashDash >= 0) argv.splice(dashDash, 0, '--json')
    else argv.push('--json')
  }

  const bin = await resolveBin()
  if (!bin.ok) return { ok: false, error: normError('cli_not_found', bin.error), ms: 0 }

  const proxy = options.noProxy
    ? { ok: true, url: '', source: 'none' }
    : (options.proxyInfo || await resolveProxy({ refresh: Boolean(options.refreshProxy) }))
  if (!proxy.ok) {
    return {
      ok: false,
      error: normError(proxy.error && proxy.error.code, (proxy.error && proxy.error.message) || '代理不可用'),
      proxy: proxy.report || null,
      ms: 0,
    }
  }

  const cred = options.credInfo || await resolveCredentials()
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
  const env = childEnv(proxy, cred, options.extraEnv)
  const shell = /\.(cmd|bat)$/i.test(bin.bin)
  const t0 = Date.now()
  const r = await execRaw(bin.bin, argv, { timeoutMs, env, shell })
  const ms = Date.now() - t0
  const stderrTail = redact(tail(r.stderr, 600))

  if (r.timedOut) {
    return { ok: false, error: normError('timeout', 'twitter ' + argv[0] + ' 超时（' + timeoutMs + 'ms）'), exitCode: -1, ms, stderr: stderrTail }
  }
  if (r.error) {
    return { ok: false, error: normError('cli_failed', r.stderr || '子进程起不来'), exitCode: r.code, ms, stderr: stderrTail }
  }

  const parsed = parseStdout(r.stdout)
  if (!parsed.value || typeof parsed.value !== 'object') {
    const hint = clean(r.stdout) ? '输出不是 JSON：' + tail(clean(r.stdout), 200) : '没有任何输出'
    return {
      ok: false,
      error: normError('bad_output', 'twitter ' + argv[0] + ' 失败（exit=' + r.code + '）：' + hint + (stderrTail ? ' | ' + stderrTail : '')),
      exitCode: r.code,
      ms,
      stderr: stderrTail,
    }
  }

  const payload = parsed.value
  if (payload.ok === false) {
    return {
      ok: false,
      error: normError(payload.error && payload.error.code, (payload.error && payload.error.message) || ('twitter ' + argv[0] + ' 失败')),
      exitCode: r.code,
      ms,
      stderr: stderrTail,
    }
  }
  return { ok: true, data: payload.data, exitCode: r.code, ms, stderr: stderrTail }
}

/** 要数据、不要返回码的写法：失败就抛（Error 上带 .code），供高阶封装用 */
export async function twData(args, opts) {
  const r = await runTw(args, opts)
  if (r.ok) return r.data
  const err = new Error((r.error && r.error.message) || 'twitter-cli 调用失败')
  err.code = (r.error && r.error.code) || 'cli_error'
  err.result = r
  throw err
}

/* ────────────────────────────── 数据映射（CLI JSON → 契约字段） ────────────────────────────── */

/** 一条推文 → 契约里的 post 结构（额外给 views/authorName，写日报要用） */
export function toPost(t) {
  const id = clean(t && t.id)
  const handle = clean(t && t.author && t.author.screenName)
  return {
    id,
    url: id ? 'https://x.com/' + (handle || 'i') + '/status/' + id : '',
    author: handle,
    authorName: clean(t && t.author && t.author.name),
    authorFollowers: null,                       // 由 enrichAuthors 补
    verified: Boolean(t && t.author && t.author.verified),
    text: String((t && t.text) ?? ''),
    likes: int(t && t.metrics && t.metrics.likes),
    replies: int(t && t.metrics && t.metrics.replies),
    retweets: int(t && t.metrics && t.metrics.retweets),
    views: int(t && t.metrics && t.metrics.views),
    createdAt: isoOrRaw(t && (t.createdAtISO || t.createdAt)),
  }
}

/** 一条回复 → 契约里的 reply 结构 */
export function toReply(t) {
  return {
    author: clean(t && t.author && t.author.screenName),
    text: String((t && t.text) ?? ''),
    likes: int(t && t.metrics && t.metrics.likes),
    createdAt: isoOrRaw(t && (t.createdAtISO || t.createdAt)),
  }
}

/** 用户档案 → 契约里的 user 结构 */
export function toUser(p) {
  const handle = clean((p && (p.screenName || p.username)) || '')
  return {
    handle,
    name: clean(p && p.name),
    bio: String((p && p.bio) ?? ''),
    followers: int(p && p.followers),
    following: int(p && p.following),
    tweets: int(p && p.tweets),
    verified: Boolean(p && p.verified),
    createdAt: isoOrRaw(p && (p.createdAtISO || p.createdAt)),
    url: handle ? 'https://x.com/' + handle : '',
  }
}

/* ────────────────────────────── 作者粉丝数（补 authorFollowers） ────────────────────────────── */

const followerCache = new Map()      // handle(lower) → number | null
const followerInflight = new Map()   // handle(lower) → Promise

/**
 * 单账号粉丝数（带缓存）。twitter-cli 的推文 JSON 里**没有**作者粉丝数，
 * 只能再查一次 user；失败就 null —— 不许因为补不到粉丝数让整次搜索失败。
 */
export async function lookupFollowers(handle, opts) {
  const options = opts || {}
  const key = clean(handle).toLowerCase()
  if (!key) return null
  if (followerCache.has(key)) return followerCache.get(key)
  if (followerInflight.has(key)) return followerInflight.get(key)
  const job = (async () => {
    try {
      const data = await twData(['user', key], { timeoutMs: options.timeoutMs || 20000 })
      const n = int(data && data.followers)
      followerCache.set(key, n)
      return n
    } catch (e) {
      log('补粉丝数失败 @' + key + '：' + (e && e.message ? e.message : e))
      followerCache.set(key, null)
      return null
    } finally {
      followerInflight.delete(key)
    }
  })()
  followerInflight.set(key, job)
  return job
}

/**
 * 给 posts 补 authorFollowers。
 * 为什么要限流：一条搜索 20 条可能是 20 个不同作者，逐个查会慢到没法用（每个都要起一次 CLI）。
 * 默认最多补 12 个（X_FOLLOWERS_MAX 可调），4 路并发；补不到的留 null。
 */
export async function enrichAuthors(posts, opts) {
  const options = opts || {}
  const cap = clamp(int(options.max ?? envInt('X_FOLLOWERS_MAX', 12)), 0, 50)
  if (!Array.isArray(posts) || !posts.length || cap <= 0) return posts
  const handles = []
  for (const p of posts) {
    const h = clean(p && p.author).toLowerCase()
    if (!h || p.authorFollowers !== null) continue
    if (handles.indexOf(h) >= 0) continue
    handles.push(h)
    if (handles.length >= cap) break
  }
  if (!handles.length) return posts

  let cursor = 0
  const worker = async () => {
    while (cursor < handles.length) {
      const h = handles[cursor]
      cursor += 1
      const n = followerCache.has(h) ? followerCache.get(h) : await lookupFollowers(h)
      for (const p of posts) if (clean(p && p.author).toLowerCase() === h) p.authorFollowers = n
    }
  }
  const size = Math.max(1, Math.min(int(options.concurrency) || 4, handles.length))
  await Promise.all(Array.from({ length: size }, worker))
  return posts
}

/* ────────────────────────────── 高阶取数（只读子命令） ────────────────────────────── */

export async function whoami(opts) {
  const data = await twData(['whoami'], opts)
  return toUser((data && data.user) || data)
}

export async function userProfile(handle, opts) {
  const h = clean(handle).replace(/^@/, '')
  if (!h) throw Object.assign(new Error('handle 不能为空'), { code: 'bad_request' })
  const data = await twData(['user', h], opts)
  return toUser(data)
}

export async function statusOf(opts) {
  const data = await twData(['status'], opts)
  return {
    authenticated: Boolean(data && data.authenticated),
    user: data && data.user ? toUser(data.user) : null,
  }
}

/** 契约里 sort 是 general|latest|popular；CLI 0.8.5 对应的是 -t Top|Latest
 *  （Top = 相关度/热度，Latest = 时间倒序；没有单独的 popular，popular 用 Top） */
function sortProduct(sort) {
  const s = clean(sort).toLowerCase()
  if (s === 'latest' || s === '最新') return 'Latest'
  return 'Top'
}

export async function search(args, opts) {
  const a = args || {}
  const q = String(a.query ?? '').trim()
  if (!q) throw Object.assign(new Error('query 不能为空'), { code: 'bad_request' })
  const n = clamp(int(a.limit) || 20, 1, 50)
  const argv = ['search', '-t', sortProduct(a.sort)]
  argv.push('-n', String(n))
  if (/^-/.test(q)) argv.push('--')     // 关键字以 - 开头时先收住选项解析
  argv.push(q)
  const data = await twData(argv, opts)
  return (Array.isArray(data) ? data : []).map(toPost)
}

export async function userPosts(args, opts) {
  const a = args || {}
  const h = clean(a.handle).replace(/^@/, '')
  if (!h) throw Object.assign(new Error('handle 不能为空'), { code: 'bad_request' })
  const n = clamp(int(a.limit) || 20, 1, 100)
  const data = await twData(['user-posts', h, '-n', String(n)], opts)
  return (Array.isArray(data) ? data : []).map(toPost)
}

/** 读推文详情：data[0] 是本体，data[1..] 是回复 */
export async function tweetDetail(args, opts) {
  const a = args || {}
  const target = clean(a.idOrUrl)
  if (!target) throw Object.assign(new Error('需要推文 id 或链接'), { code: 'bad_request' })
  const n = clamp(int(a.replies ?? 20), 0, 50)
  const argv = ['tweet', target]
  if (n > 0) argv.push('-n', String(n))
  const data = await twData(argv, opts)
  const list = Array.isArray(data) ? data : []
  if (!list.length) return null
  return { tweet: list[0], replies: list.slice(1) }
}

/**
 * 蓝标比例（近似口径）：抽样关注者，数 verified 的比例。
 * 这不是官方"蓝V粉"数字，只是量级参考 —— 报表里必须注明是抽样。
 * 抽样条数默认 60（X_BLUE_SAMPLE 可调，0 = 不测）。
 */
export async function blueRatioOf(handle, opts) {
  const options = opts || {}
  const n = clamp(int(options.sample ?? envInt('X_BLUE_SAMPLE', 60)), 0, 200)
  const h = clean(handle).replace(/^@/, '')
  if (!n || !h) return null
  try {
    const data = await twData(['followers', h, '-n', String(n)], { timeoutMs: options.timeoutMs || 90000 })
    const list = Array.isArray(data) ? data : []
    if (!list.length) return null
    const blue = list.filter((u) => Boolean(u && u.verified)).length
    return {
      verified: blue,
      sample: list.length,
      ratio: Math.round((blue / list.length) * 1000) / 1000,
      note: '抽样关注者 ' + list.length + ' 人里 ' + blue + ' 个带蓝标（近似口径，非官方数据）',
    }
  } catch (e) {
    log('蓝标抽样失败：' + (e && e.message ? e.message : e))
    return null
  }
}

export { sleep }
