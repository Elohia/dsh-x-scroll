#!/usr/bin/env node
/**
 * selfcheck.mjs —— dsh-x-scroll 环境自检（零依赖，Node >= 22）
 * ============================================================================
 * 用一条命令回答"这台机器现在能不能跑这一轮"：
 *   ① 环境：twitter 二进制在哪、CLI 版本、代理端口通不通、写操作开关状态
 *   ② 凭据：TWITTER_AUTH_TOKEN / TWITTER_CT0 有没有（**只报有无，不显示值**）
 *   ③ 连通：真跑一次 `twitter status --json`，看账号能不能读出来
 *   ④ 依赖：node / twitter-cli / nodemailer（可选）/ 家目录可写；缺项给修复命令
 *      （必须依赖缺 ⇒ 退出码 2；nodemailer 只影响邮件通道，缺了只提示）

 * 写操作（CONTRACT v0.2）只**报状态**、不改变退出码：总闸关着就是只读；开着也只说明"允许"，
 * 真正能不能动手还要过 MCP 的额度 / 确认 / 去重 / 内容闸门。
 *
 * 用法：
 *   node selfcheck.mjs           人看的分段输出（环境 / 凭据 / 连通 / 依赖）
 *   node selfcheck.mjs --json    机器吃（stdout 一段 JSON，日志全走 stderr）
 *
 * 退出码：0 = 三段全通过；2 = 有缺（缺什么看 ✗ 那几行）。
 *
 * 解析顺序（都不写死个人路径）：
 *   twitter 二进制：X_TWITTER_BIN → 配置 twitterBin → PATH 里的 twitter
 *   代理：X_PROXY → 配置 proxy → 探测 127.0.0.1:7890 → 127.0.0.1:7892 → 系统代理设置
 *   凭据：进程环境 → HKCU\Environment（Windows 用户环境变量）
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const WANT_VERSION = '0.8.5' // 实测可用的 twitter-cli 版本
const MIN_VERSION = [0, 8, 0]
const NODE_MIN_MAJOR = 22
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PROBE_CANDIDATES = ['http://127.0.0.1:7890', 'http://127.0.0.1:7892']
const IS_WIN = platform() === 'win32'
const AS_JSON = process.argv.includes('--json')

/* ───────────────────────────── 小工具 ───────────────────────────── */

/** 跑一个子进程，带超时；stdout/stderr 收成字符串，不写盘。 */
function run(cmd, args, { env, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    let child
    const finish = (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout: out, stderr: err })
    }
    let timer = null
    try {
      child = spawn(cmd, args, { env: env || process.env, windowsHide: true })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e) })
      return
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经死了 */ }
      finish(-2)
    }, Math.max(1000, timeoutMs))
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => { err += String(e?.message || e); finish(-1) })
    child.on('close', (c) => finish(c))
  })
}

function parseJsonLoose(text) {
  const s = String(text || '').trim()
  if (!s) return null
  try { return JSON.parse(s) } catch { /* 下面从第一个 { 截到最后一个 } */ }
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try { return JSON.parse(s.slice(a, b + 1)) } catch { return null }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/* ───────────────────────────── 家目录 / 配置 ───────────────────────────── */

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const dutyHome = process.env.X_DUTY_HOME || join(dshHome, 'x-duty')
const configPath = join(dutyHome, 'config.json')
const config = readJson(configPath) || {}

/* ───────────────────────────── ① 环境 ───────────────────────────── */

/** 系统工具兜底：PATH 被改坏时也能找到 where/reg（Windows 下走 System32 绝对路径） */
async function runSystemTool(name, args, timeoutMs = 5000) {
  const direct = await run(name, args, { timeoutMs })
  if (direct.code !== -1 || !IS_WIN) return direct
  const abs = join(process.env.SystemRoot || 'C:\\Windows', 'System32', name)
  return run(abs, args, { timeoutMs })
}

/** PATH 里的 twitter（Windows 用 where，其它用 which） */
async function findOnPath() {
  const r = IS_WIN
    ? await runSystemTool('where.exe', ['twitter'])
    : await run('which', ['twitter'], { timeoutMs: 5000 })
  if (r.code !== 0) return ''
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return first || ''
}

/** 常见安装位置（全部从 home / 环境变量推导，不写死任何个人绝对路径） */
function defaultBinCandidates() {
  const home = homedir()
  const localAppData = String(process.env.LOCALAPPDATA || '').trim()
  const appData = String(process.env.APPDATA || '').trim()
  const out = [
    join(home, '.local', 'bin', 'twitter.exe'),
    join(home, '.local', 'bin', 'twitter'),
  ]
  if (localAppData) {
    out.push(join(localAppData, 'pipx', 'pipx', 'venvs', 'twitter-cli', 'Scripts', 'twitter.exe'))
    out.push(join(localAppData, 'Programs', 'Python', 'Scripts', 'twitter.exe'))
  }
  if (appData) out.push(join(appData, 'Python', 'Scripts', 'twitter.exe'))
  return out
}

function isFile(p) {
  try { return Boolean(p) && existsSync(p) && statSync(p).isFile() } catch { return false }
}

/**
 * 二进制解析（与插件 lib/xcli.mjs 同序）：
 *   配置 twitterBin（严格）→ X_TWITTER_BIN（严格）→ 常见安装位置 → PATH
 * 显式指定的路径用了却不存在 ⇒ 直接算失败，不偷偷换成别的二进制（否则排查时看不出是谁在跑）。
 */
async function resolveTwitterBin() {
  const tried = []
  const explicit = []
  const pushExplicit = (bin, source) => {
    const b = String(bin || '').trim()
    if (b && !explicit.some((t) => t.bin.toLowerCase() === b.toLowerCase())) explicit.push({ bin: b, source })
  }
  pushExplicit(config.twitterBin, '配置 twitterBin')
  pushExplicit(process.env.X_TWITTER_BIN, '环境变量 X_TWITTER_BIN')

  for (const t of explicit) {
    tried.push(t.bin)
    if (isFile(t.bin)) return { ...t, explicit: true, tried }
    return { bin: '', source: t.source, explicit: true, tried, error: `你指定的 twitter 不存在：${t.bin}` }
  }

  for (const cand of defaultBinCandidates()) {
    if (!tried.some((x) => x.toLowerCase() === cand.toLowerCase())) tried.push(cand)
    if (isFile(cand)) return { bin: cand, source: '常见安装位置', tried }
  }
  const onPath = await findOnPath()
  if (onPath) {
    tried.push(onPath)
    return { bin: onPath, source: 'PATH', tried }
  }
  return { bin: '', source: '', tried }
}

/** 'twitter.EXE, version 0.8.5' → [0,8,5] */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function versionAtLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true
    if (v[i] < min[i]) return false
  }
  return true
}

/** '127.0.0.1:7890' / 'http=127.0.0.1:7890;https=...' / 'http://x:y' → 'http://host:port' */
function normalizeProxy(raw) {
  let s = String(raw || '').trim()
  if (!s) return ''
  if (/^[a-z][a-z0-9+.-]*=\S/i.test(s)) {
    const map = {}
    for (const part of s.split(';')) {
      const i = part.indexOf('=')
      if (i > 0) map[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim()
    }
    s = map.https || map.http || map.socks || ''
    if (!s) return ''
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s
  try {
    const u = new URL(s)
    if (!u.hostname || !u.port) return ''
    return u.origin
  } catch { return '' }
}

/** Windows：HKCU\Internet Settings 的 ProxyServer（ProxyEnable=0 时不认） */
async function readSystemProxy() {
  if (!IS_WIN) return ''
  const en = await runSystemTool('reg.exe', ['query', 'HKCU\\Internet Settings', '/v', 'ProxyEnable'])
  const em = /ProxyEnable\s+REG_\w+\s+(0x0|0)\b/i.exec(en.stdout || '')
  if (en.code === 0 && em) return ''
  const r = await runSystemTool('reg.exe', ['query', 'HKCU\\Internet Settings', '/v', 'ProxyServer'])
  if (r.code !== 0) return ''
  const m = /ProxyServer\s+REG_\w+\s+(.+)/i.exec(r.stdout || '')
  return m ? normalizeProxy(m[1]) : ''
}

/** TCP 探活（毫秒级，不握手 HTTP） */
function probeTcp(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve({ ok: false, ms: 0, error: 'URL 不合法' }) }
    const started = Date.now()
    let done = false
    const socket = net.connect({ host: u.hostname, port: Number(u.port || 80) })
    const finish = (ok, error) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - started, error })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true, ''))
    socket.once('timeout', () => finish(false, 'TIMEOUT'))
    socket.once('error', (e) => finish(false, e?.code || String(e?.message || e)))
  })
}

const DIRECT_VALUES = ['direct', 'none', 'off', 'no', 'noproxy', '直连']

function isDirect(v) {
  return DIRECT_VALUES.includes(String(v || '').trim().toLowerCase())
}

/**
 * 代理解析（与插件 lib/xcli.mjs 同序）：
 *   配置 proxy → X_PROXY → TWITTER_PROXY → HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
 *   → 探测 127.0.0.1:7890 → 127.0.0.1:7892 → 系统代理；逐个真 TCP 探活，取第一个通的。
 * 想直连（机器本来就在墙外）：proxy 写 direct，或设 X_DIRECT=1。
 */
async function resolveProxy() {
  const direct = /^(1|true|yes|on)$/i.test(String(process.env.X_DIRECT || ''))
    || isDirect(config.proxy) || isDirect(process.env.X_PROXY)
  if (direct) return { direct: true, url: '', source: '直连（direct）', candidates: [] }

  const tries = []
  const push = (hit, source, strict = false) => {
    const url = normalizeProxy(hit)
    if (url && !tries.some((t) => t.url === url)) tries.push({ url, source, strict })
  }
  push(config.proxy, '配置 proxy', true)
  push(process.env.X_PROXY, '环境变量 X_PROXY', true)
  push(process.env.TWITTER_PROXY, '环境变量 TWITTER_PROXY')
  push(process.env.HTTPS_PROXY || process.env.https_proxy, '环境变量 HTTPS_PROXY')
  push(process.env.HTTP_PROXY || process.env.http_proxy, '环境变量 HTTP_PROXY')
  push(process.env.ALL_PROXY || process.env.all_proxy, '环境变量 ALL_PROXY')
  push(PROBE_CANDIDATES[0], '探测', false)
  push(PROBE_CANDIDATES[1], '探测', false)
  const sys = await readSystemProxy()
  if (sys) push(sys, '系统代理 HKCU\\Internet Settings')

  const results = []
  for (const t of tries) {
    const p = await probeTcp(t.url)
    results.push({ ...t, ...p })
    if (p.ok) return { direct: false, url: t.url, source: t.source, candidates: results }
    // 显式指定的（设置页 / X_PROXY）连不上就直接报错，不偷偷换别的 —— 与插件 lib/xcli.mjs 一致
    if (t.strict) {
      return {
        direct: false,
        url: '',
        source: t.source,
        candidates: results,
        error: `你指定的代理连不上（${t.url}，来源：${t.source}）—— 先启动代理软件，或改设置；想直连就把 proxy 设成 direct`,
      }
    }
  }
  return {
    direct: false,
    url: '',
    source: '',
    candidates: results,
    error: '没有可用的代理（自动探测 127.0.0.1:7890 / :7892 和系统代理都连不上）—— 先启动代理，或设 X_PROXY；想直连就把 proxy 设成 direct',
  }
}

/* ───────────────────────────── ② 凭据 ───────────────────────────── */

/** 读 HKCU\Environment 里的环境变量（只返回有没有，值用完就丢） */
async function readUserEnv(name) {
  if (!IS_WIN) return { present: false, source: '' }
  const r = await runSystemTool('reg.exe', ['query', 'HKCU\\Environment', '/v', name])
  if (r.code !== 0) return { present: false, source: '' }
  const re = new RegExp(name + '\\s+REG_\\w+\\s+(.+)', 'i')
  const m = re.exec(r.stdout || '')
  const value = m ? m[1].trim() : ''
  return { present: value.length > 0, source: value.length > 0 ? 'HKCU\\Environment' : '', value }
}

async function resolveCred(name) {
  const fromEnv = String(process.env[name] || '').trim()
  if (fromEnv) return { present: true, source: '进程环境', value: fromEnv }
  const reg = await readUserEnv(name)
  return { present: reg.present, source: reg.source, value: reg.value || '' }
}

/* ───────────────────────────── ③ 连通 ───────────────────────────── */

/** 兜底脱敏：万一 CLI 把凭据回显进报错，也不让它出现在输出里 */
function redact(text, secrets) {
  let s = String(text || '')
  for (const v of secrets) {
    if (v && String(v).length >= 8) s = s.split(String(v)).join('<已隐藏>')
  }
  return s
}

const PROXY_KEYS = ['TWITTER_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

function childEnv({ token, ct0, proxy, direct }) {
  const env = { ...process.env }
  if (token) env.TWITTER_AUTH_TOKEN = token
  if (ct0) env.TWITTER_CT0 = ct0
  if (proxy) {
    env.TWITTER_PROXY = proxy
    for (const k of PROXY_KEYS) env[k] = proxy
  } else if (direct) {
    // 直连模式：把继承来的代理变量清掉，否则子进程还是会走代理
    for (const k of PROXY_KEYS) delete env[k]
  }
  return env
}

/* ───────────────────────── ④ 依赖检查（缺项给修复命令） ───────────────────────── */

function depNode() {
  const major = Number(process.versions.node.split('.')[0])
  return {
    ok: major >= NODE_MIN_MAJOR,
    detail: 'v' + process.versions.node + (major >= NODE_MIN_MAJOR ? '' : `（需要 ≥ ${NODE_MIN_MAJOR}）`),
    fix: '升级 Node 到 22 或更新（nodejs.org 安装包，或 winget upgrade OpenJS.NodeJS.LTS）',
    cmd: 'winget upgrade OpenJS.NodeJS.LTS',
  }
}

function depTwitter(bin, version) {
  if (!bin.bin) {
    return {
      ok: false,
      detail: '未找到可执行文件',
      fix: '装 twitter-cli（有 pipx 用 pipx；没有就 pip --user）',
      cmd: 'pipx install twitter-cli    # 没有 pipx 时：python -m pip install --user twitter-cli',
    }
  }
  if (!version.ok) {
    return {
      ok: false,
      detail: `${bin.bin}（版本 ${version.text || '读不到'}，需要 ≥ ${MIN_VERSION.join('.')}）`,
      fix: '升级 twitter-cli',
      cmd: 'pipx upgrade twitter-cli',
    }
  }
  return { ok: true, detail: `${version.text}（${bin.bin}）`, fix: '', cmd: '' }
}

function depNodemailer() {
  try {
    const req = createRequire(join(PLUGIN_DIR, 'package.json'))
    req.resolve('nodemailer')
    return { ok: true, optional: true, detail: '已安装（邮件通道可用）', fix: '', cmd: '' }
  } catch {
    return {
      ok: false,
      optional: true,
      detail: '未安装（只影响邮件投递，不影响日报与投递到会话）',
      fix: '在插件目录装运行依赖；npm 装不上再 pnpm add nodemailer',
      cmd: `cd "${PLUGIN_DIR}" && npm install --omit=dev`,
    }
  }
}

function depHome() {
  try {
    mkdirSync(dutyHome, { recursive: true })
    accessSync(dutyHome, fsConstants.W_OK)
    return { ok: true, detail: dutyHome, fix: '', cmd: '' }
  } catch (e) {
    return {
      ok: false,
      detail: `${dutyHome}（${e?.code || e?.message || '不可写'}）`,
      fix: '检查目录权限，或把 DSH_HOME / X_DUTY_HOME 指到可写目录',
      cmd: 'set X_DUTY_HOME=<可写目录>    # PowerShell: $env:X_DUTY_HOME=\'<可写目录>\'',
    }
  }
}

/* ───────────────────────── 写操作开关状态（只报，不判失败） ───────────────────────── */

const WRITE_SWITCHES = [
  ['allowLike', '点赞'],
  ['allowFollow', '关注'],
  ['allowReply', '回复'],
  ['allowPost', '发帖'],
]

/** 宽松布尔：config.json 手改成 "true" / 1 也认（与 lib/writegate.mjs 的 asBool 一致） */
function asBool(v) {
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  const s = String(v ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

function writeView() {
  const switches = WRITE_SWITCHES.map(([key, label]) => ({ key, label, on: asBool(config[key]) }))
  const master = asBool(config.allowWrite)
  const enabled = master ? switches.filter((s) => s.on) : []
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  return {
    master,
    switches,
    enabled: enabled.map((s) => s.label),
    count: enabled.length,
    limits: {
      likes: num(config.maxLikesPerDay, 20),
      follows: num(config.maxFollowsPerDay, 10),
      replies: num(config.maxRepliesPerDay, 5),
      posts: num(config.maxPostsPerDay, 3),
    },
    requireConfirm: {
      reply: config.replyRequireConfirm === undefined ? true : asBool(config.replyRequireConfirm),
      post: config.postRequireConfirm === undefined ? true : asBool(config.postRequireConfirm),
    },
  }
}

/** 人看的一行：全关 / 已开 N 项（含额度与确认状态） */
function writeText(w) {
  if (!w.master) return '全关（总闸 allowWrite=false，默认；本轮只读）'
  if (!w.count) return '总闸已开，但四个单项开关全关（不会动手）'
  const l = w.limits
  const c = w.requireConfirm
  return `已开 ${w.count} 项：${w.enabled.join(' / ')}（每日上限 点赞 ${l.likes} / 关注 ${l.follows} / 回复 ${l.replies} / 发帖 ${l.posts}；回复${c.reply ? '需确认' : '免确认'}、发帖${c.post ? '需确认' : '免确认'}）`
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

async function main() {
  const startedAt = new Date()
  const failures = []
  const checks = {}
  const write = writeView()

  // ① 环境：二进制 / 版本 / 代理
  const bin = await resolveTwitterBin()
  const version = { ok: false, text: '', tuple: null }
  if (bin.bin) {
    const r = await run(bin.bin, ['--version'], { timeoutMs: 20000 })
    const text = (String(r.stdout || '') + String(r.stderr || '')).trim()
    const tuple = parseVersion(text)
    if (tuple) {
      version.ok = versionAtLeast(tuple, MIN_VERSION)
      version.text = tuple.join('.')
      version.tuple = tuple
    } else {
      version.text = text.split(/\r?\n/)[0] || `退出码 ${r.code}`
    }
  }
  if (!bin.bin) failures.push('twitter 二进制')
  else if (!version.ok) failures.push('CLI 版本')

  const proxy = await resolveProxy()
  if (!proxy.url && !proxy.direct) failures.push('代理')

  // ② 凭据（值只在内存里过一遍，绝不打印/落盘）
  const token = await resolveCred('TWITTER_AUTH_TOKEN')
  const ct0 = await resolveCred('TWITTER_CT0')
  const credOk = token.present && ct0.present
  if (!credOk) failures.push('凭据')

  // ③ 连通：真跑一次 status
  const account = { ok: false, skipped: false, handle: '', name: '', followers: null, following: null, tweets: null, verified: null, error: '' }
  if (!bin.bin) {
    account.skipped = true
    account.error = '没有 twitter 二进制，跳过'
  } else if (!proxy.url && !proxy.direct) {
    account.skipped = true
    account.error = '没有可用代理，跳过'
  } else if (!credOk) {
    account.skipped = true
    account.error = '没有凭据，跳过'
  } else {
    const env = childEnv({ token: token.value, ct0: ct0.value, proxy: proxy.url, direct: proxy.direct })
    const r = await run(bin.bin, ['status', '--json'], { env, timeoutMs: 60000 })
    const data = parseJsonLoose(r.stdout)
    const user = data?.data?.user
    if (r.code === 0 && data?.ok === true && data?.data?.authenticated === true && user) {
      account.ok = true
      account.handle = String(user.username || user.screenName || '')
      account.name = String(user.name || '')
      account.followers = Number(user.followers ?? 0)
      account.following = Number(user.following ?? 0)
      account.tweets = Number(user.tweets ?? 0)
      account.verified = user.verified === true
    } else {
      const hint = (String(r.stderr || '').trim() || String(r.stdout || '').trim()).split(/\r?\n/)[0] || ''
      account.error = r.code === -2
        ? '调用超时（60s）'
        : (redact(hint, [token.value, ct0.value]).slice(0, 200) || `退出码 ${r.code}`)
    }
  }
  if (!account.ok && !account.skipped) failures.push('连通')

  // ④ 依赖（node / twitter-cli / nodemailer / 家目录）
  const deps = {
    node: depNode(),
    twitter: depTwitter(bin, version),
    nodemailer: depNodemailer(),
    home: depHome(),
  }
  if (!deps.node.ok) failures.push('Node 版本')
  if (!deps.home.ok) failures.push('家目录不可写')

  const credView = {
    token: { present: token.present, source: token.source },
    ct0: { present: ct0.present, source: ct0.source },
    ok: credOk
  }
  checks.cli = { ok: Boolean(bin.bin) && version.ok, bin: bin.bin, binSource: bin.source, version: version.text, versionOk: version.ok, tried: bin.tried }
  checks.proxy = { ok: Boolean(proxy.url) || Boolean(proxy.direct), direct: Boolean(proxy.direct), url: proxy.url, source: proxy.source, error: proxy.error || '', candidates: proxy.candidates.map((c) => ({ url: c.url, source: c.source, strict: Boolean(c.strict), ok: c.ok, ms: c.ms, error: c.error })) }
  checks.credentials = credView
  checks.account = account
  checks.deps = deps
  checks.write = write
  checks.dutyHome = dutyHome
  checks.configFound = Boolean(readJson(configPath))

  const ok = failures.length === 0
  if (AS_JSON) {
    const payload = {
      ok,
      generatedAt: startedAt.toISOString(),
      runtime: { node: process.version, platform, arch: process.arch, dshHome, dutyHome, configFound: checks.configFound },
      checks,
      failures
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    process.exitCode = ok ? 0 : 2
    return
  }

  const L = []
  const line = (s = '') => L.push(s)
  const mark = (good) => (good ? '✓' : '✗')
  line('='.repeat(72))
  line(`dsh-x-scroll 环境自检 · ${startedAt.toLocaleString('zh-CN', { hour12: false })}`)
  line(`node ${process.version} · ${platform()} · 家目录 ${dutyHome}`)
  line('='.repeat(72))
  line()

  line('① 环境')
  if (bin.bin) {
    line(`  ✓ twitter   ${bin.bin}`)
    line(`             来源：${bin.source || '未知'}`)
  } else {
    line(`  ✗ twitter   ${bin.error || '没找到（设 X_TWITTER_BIN，或在设置页填 twitterBin，或把它放进 PATH）'}`)
  }
  if (bin.bin) {
    const vnote = version.tuple && !versionAtLeast(version.tuple, [0, 8, 5]) ? `（实测可用的是 ${WANT_VERSION}，版本偏低可能字段对不上）` : ''
    line(`  ${mark(version.ok)} 版本      ${version.text || '读不到'}${vnote}`)
  }
  if (proxy.direct) {
    line('  ✓ 代理      直连（direct：不走代理；继承来的代理变量已清掉）')
  } else if (proxy.url) {
    line(`  ✓ 代理      ${proxy.url}（来源：${proxy.source}）`)
  } else {
    line(`  ✗ 代理      ${proxy.error || '没有可用代理（最省事的办法：开 Clash 之类让 127.0.0.1:7890 通；机器在墙外就设 X_DIRECT=1）'}`)
  }
  const probes = (proxy.candidates || []).map((c) => `${new URL(c.url).host} ${c.ok ? '✓ ' + c.ms + 'ms' : '✗ ' + (c.error || '不通')}`)
  if (probes.length) line(`             探测：${probes.join(' · ')}`)
  line(`  ${write.master ? '⚠' : '•'} 写操作    ${writeText(write)}`)
  line()

  line('② 凭据（只报有无，不显示值）')
  for (const [label, c] of [['TWITTER_AUTH_TOKEN', credView.token], ['TWITTER_CT0', credView.ct0]]) {
    if (c.present) line(`  ✓ ${label.padEnd(19)} 有（来源：${c.source}）`)
    else line(`  ✗ ${label.padEnd(19)} 没有（放进程环境，或写进 HKCU\\Environment）`)
  }
  line()

  line('③ 连通')
  if (account.ok) {
    line(`  ✓ 认证      @${account.handle}${account.name ? `（${account.name}）` : ''}`)
    line(`             粉丝 ${account.followers} · 关注 ${account.following} · 推文 ${account.tweets} · 蓝V ${account.verified ? '是' : '否'}`)
  } else {
    line(`  ${account.skipped ? '-' : '✗'} ${account.skipped ? '跳过' : '认证失败'}：${account.error}`)
  }
  line()

  line('④ 依赖')
  line(`  ${mark(deps.node.ok)} node          ${deps.node.detail}`)
  line(`  ${mark(deps.twitter.ok)} twitter-cli   ${deps.twitter.detail}`)
  line(`  ${deps.nodemailer.ok ? '✓' : '•'} nodemailer    ${deps.nodemailer.detail}`)
  line(`  ${mark(deps.home.ok)} 家目录        ${deps.home.detail}`)
  for (const [name, d] of [['node', deps.node], ['twitter-cli', deps.twitter], ['nodemailer', deps.nodemailer], ['家目录', deps.home]]) {
    if (d.ok) continue
    const head = d.optional ? '可选修复' : '修复'
    line(`             ${head}（${name}）：${d.fix}`)
    if (d.cmd) line(`             命令：${d.cmd}`)
  }
  if (!deps.nodemailer.ok) line('             （nodemailer 只影响邮件通道：缺了它日报/会话投递照常）')
  line()

  if (ok) {
    line('结论：全部通过（环境 / 凭据 / 连通 / 依赖）—— 可以跑一轮了（设置页点「现在跑一轮」，或让 AI 调 x_run）。')
  } else {
    line(`结论：未通过 —— 缺 ${failures.join(' / ')}。先修 ✗ 那几行；装/排查步骤见 README「依赖与一键安装」与「排错」。`)
  }
  line(`退出码：${ok ? 0 : 2}`)
  process.stdout.write(L.join('\n') + '\n')
  process.exitCode = ok ? 0 : 2
}

main().catch((e) => {
  const msg = `selfcheck 崩了：${e?.stack || e}`
  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2) + '\n')
    process.stderr.write(msg + '\n')
  } else {
    process.stderr.write(msg + '\n')
  }
  process.exitCode = 2
})
