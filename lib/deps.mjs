/**
 * lib/deps.mjs —— 依赖自检与一键安装
 * ============================================================================
 * 这个模块只做两件事：
 *   checkDeps()   逐项体检：Node 版本 / twitter-cli / nodemailer / 家目录可写 / 插件文件完整
 *   installDeps() 幂等安装：缺 nodemailer → npm install --omit=dev（失败回退 pnpm add）；
 *                 缺 twitter-cli → pipx install twitter-cli（没有 pipx 就给出准确命令）。
 *
 * 边界（很重要）：
 *   - **只装依赖**：npm / pnpm / pipx。**绝不**调用 twitter-cli 的业务命令，也绝不碰 X 账号。
 *   - 每项返回 {ok, detail, fix, cmd}：出问题给人「为什么 + 怎么修 + 可抄的命令」，不是一句失败。
 *   - install 全程写 install.log（默认家目录；家目录不可写就退到插件目录），返回 tail 给设置页。
 *   - 幂等：已满足的项直接跳过；重复点安装不会重复装。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const NODE_MIN_MAJOR = 22

/** 插件运行必需的核心文件（缺了就不是"装完整"） */
const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'lib/state.mjs',
  'lib/mcp.mjs',
  'lib/deliver.mjs',
  'lib/deps.mjs',
  'server/mcp_server.mjs',
  'prompts/duty.md',
]

const nowIso = () => new Date().toISOString()

const clip = (s, n = 4000) => {
  const t = String(s == null ? '' : s)
  return t.length > n ? t.slice(-n) : t
}

function defaultHome() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'x-duty')
}

/** 跑一个外部命令，带超时与输出截断；从不抛 */
function runCmd(cmd, args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: process.env,
      })
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: String(e && e.message || e), notFound: false })
      return
    }
    let out = ''
    let err = ''
    let done = false
    let timer = null
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ stdout: clip(out), stderr: clip(err), ...r })
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      finish({ ok: false, code: null, timedOut: true, error: '超时 ' + timeoutMs + 'ms' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { err += String(b) })
    child.on('error', (e) => finish({ ok: false, code: null, error: String(e && e.message || e), notFound: e && e.code === 'ENOENT' }))
    child.on('exit', (code) => finish({ ok: code === 0, code }))
  })
}

/** where / which 找一个可执行文件；返回第一行绝对路径或空串 */
async function which(bin) {
  const r = process.platform === 'win32'
    ? await runCmd('where', [bin], { timeoutMs: 10000 })
    : await runCmd('which', [bin], { timeoutMs: 10000 })
  if (!r.ok) return ''
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  return first || ''
}

/* ───────────────────────────── 单项体检 ───────────────────────────── */

function checkNode() {
  const v = process.versions.node
  const major = Number(String(v).split('.')[0]) || 0
  if (major >= NODE_MIN_MAJOR) return { ok: true, detail: 'Node ' + v + '（要求 >= ' + NODE_MIN_MAJOR + '）' }
  return {
    ok: false,
    detail: 'Node ' + v + ' 太旧（要求 >= ' + NODE_MIN_MAJOR + '）',
    fix: '升级 Node 到 >= ' + NODE_MIN_MAJOR + '（nodejs.org 安装包，或 winget upgrade OpenJS.NodeJS.LTS）',
    cmd: 'winget upgrade OpenJS.NodeJS.LTS',
  }
}

/** twitter-cli：配置路径 → X_TWITTER_BIN → PATH → pipx 标准位置。只跑 --version，不碰账号 */
async function checkTwitter(options = {}) {
  const candidates = []
  const push = (p) => { const v = String(p || '').trim(); if (v && !candidates.includes(v)) candidates.push(v) }
  push(options.twitterBin)
  push(process.env.X_TWITTER_BIN)
  const onPath = await which('twitter')
  push(onPath)
  push('twitter')
  if (process.platform === 'win32') push('twitter.exe')
  const localBin = process.platform === 'win32'
    ? join(homedir(), '.local', 'bin', 'twitter.exe')
    : join(homedir(), '.local', 'bin', 'twitter')
  push(localBin)

  for (const bin of candidates) {
    if (!bin) continue
    const r = await runCmd(bin, ['--version'], { timeoutMs: 15000 })
    const text = String(r.stdout || '') + ' ' + String(r.stderr || '')
    const m = text.match(/(\d+\.\d+\.\d+)/)
    if (r.ok || m) {
      const version = m ? m[1] : '?'
      return { ok: true, detail: 'twitter-cli ' + version + ' · ' + bin, version, bin }
    }
  }
  return {
    ok: false,
    detail: '找不到可用的 twitter-cli（试过：' + (candidates.filter(Boolean).join(' / ') || '无') + '）',
    fix: '装 twitter-cli：有 pipx 就 pipx install twitter-cli；没有就 pip install --user twitter-cli。装完确认 twitter --version 能跑',
    cmd: 'pipx install twitter-cli',
  }
}

function checkNodemailer(pluginDir) {
  try {
    const req = createRequire(join(pluginDir, 'package.json'))
    const resolved = req.resolve('nodemailer')
    let version = ''
    try { version = String(req('nodemailer/package.json').version || '') } catch { /* exports 不让读就算了 */ }
    return { ok: true, detail: 'nodemailer ' + (version || '?') + ' · ' + resolved, path: resolved }
  } catch {
    return {
      ok: false,
      detail: '插件目录里没有可用的 nodemailer（邮件投递会不可用；其它功能不受影响）',
      fix: '在插件目录跑 npm install --omit=dev；npm 装不上再 pnpm add nodemailer',
      cmd: 'npm install --omit=dev',
    }
  }
}

function checkHome(home) {
  const dir = String(home || defaultHome())
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, '.deps-write-probe')
    writeFileSync(probe, 'ok', 'utf8')
    const ok = readFileSync(probe, 'utf8') === 'ok'
    try { rmSync(probe, { force: true }) } catch { /* 删不掉也无所谓 */ }
    if (ok) return { ok: true, detail: '可写 · ' + dir }
    return {
      ok: false,
      detail: '写进去了但读不回 · ' + dir,
      fix: '检查目录权限，或把 DSH_HOME 指到可写目录',
      cmd: 'mkdir "' + dir + '"',
    }
  } catch (e) {
    return {
      ok: false,
      detail: '不可写 · ' + dir + '（' + String(e && e.message || e) + '）',
      fix: '检查目录权限，或把 DSH_HOME 指到可写目录（DSH_HOME 现在是 ' + (process.env.DSH_HOME || '未设置') + '）',
      cmd: 'mkdir "' + dir + '"',
    }
  }
}

function checkFiles(pluginDir) {
  const miss = new Set(REQUIRED_FILES.filter((f) => !existsSync(join(pluginDir, f))))
  // 再把 package.json 的 files 清单对一遍（发布产物/dist 是否完整）
  try {
    const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
    for (const f of Array.isArray(pkg.files) ? pkg.files : []) {
      const rel = String(f || '').replace(/\\/g, '/')
      if (rel && !existsSync(join(pluginDir, rel))) miss.add('files:' + rel)
    }
  } catch { /* package.json 本身缺了会在 REQUIRED_FILES 里报 */ }
  const missing = [...miss]
  if (!missing.length) return { ok: true, detail: REQUIRED_FILES.length + ' 个核心文件与 package.json files 清单齐全' }
  return {
    ok: false,
    detail: '缺 ' + missing.length + ' 个核心文件：' + missing.join('、'),
    fix: '插件包不完整：重新安装/重新拷贝插件目录（dsh plugin --profile desktop add "link:<插件目录>"）',
    cmd: 'dsh plugin --profile desktop add "link:' + pluginDir + '"',
  }
}

/**
 * 依赖体检。options: { pluginDir?, home?, twitterBin? }
 * 返回 {ok, checkedAt, home, pluginDir, items:[{id,label,ok,detail,fix,cmd}], missing, summary}
 */
export async function checkDeps(options = {}) {
  const pluginDir = options.pluginDir || PLUGIN_DIR
  const home = String(options.home || defaultHome())
  const tw = await checkTwitter(options)
  const raw = [
    { id: 'node', label: 'Node.js', ...checkNode() },
    { id: 'twitter', label: 'twitter-cli', ...tw },
    { id: 'nodemailer', label: 'nodemailer（邮件投递）', ...checkNodemailer(pluginDir) },
    { id: 'home', label: '插件家目录可写', ...checkHome(home) },
    { id: 'files', label: '插件文件完整', ...checkFiles(pluginDir) },
  ]
  // 每个 item 固定有 fix / cmd 两个字符串（ok 时为空），调用方不用判 undefined
  const items = raw.map((it) => ({ ...it, fix: String(it.fix || ''), cmd: String(it.cmd || '') }))
  const missing = items.filter((it) => !it.ok).map((it) => it.id)
  return {
    ok: missing.length === 0,
    checkedAt: nowIso(),
    home,
    pluginDir,
    node: process.versions.node,
    items,
    missing,
    summary: { total: items.length, ok: items.length - missing.length, missing: missing.length },
  }
}

/* ───────────────────────────── 一键安装 ───────────────────────────── */

let installing = false

/**
 * 幂等安装。options 同 checkDeps；log 可选（额外回调）。
 * 返回 {ok, busy?, at, durationMs, log, logFile, steps:[{id,ok,skipped,detail,cmd}], checks, tail}
 * 只调用 npm / pnpm / pipx；不调用 twitter-cli 业务命令，不碰 X 账号。
 */
export async function installDeps(options = {}, log = () => {}) {
  if (installing) return { ok: false, busy: true, at: nowIso(), error: '已经有一个安装在跑，等它结束' }
  installing = true
  const startedAt = Date.now()
  const pluginDir = options.pluginDir || PLUGIN_DIR
  const home = String(options.home || defaultHome())
  const logLines = []
  let logFile = join(home, 'install.log')

  const append = (line) => {
    const text = nowIso() + '  ' + line
    logLines.push(text)
    const writeTo = (file) => {
      try { appendFileSync(file, text + '\n', 'utf8'); return true } catch { return false }
    }
    if (writeTo(logFile)) return
    // 家目录不可写：退到插件目录（再不行就只留内存里的 tail）
    logFile = join(pluginDir, 'install.log')
    writeTo(logFile)
  }

  const steps = []
  try {
    append('=== install 开始 · plugin=' + pluginDir + ' · home=' + home + ' ===')
    append('边界：只装依赖（npm / pnpm / pipx），不调用 twitter-cli 业务命令、不碰 X 账号')

    // ① 家目录（安装日志也落这儿）
    const homeChk = checkHome(home)
    if (homeChk.ok) append('[home] 已可写，跳过')
    else append('[home] 不可写：' + homeChk.detail)
    steps.push({ id: 'home', ok: homeChk.ok, skipped: homeChk.ok, detail: homeChk.detail, cmd: homeChk.ok ? '' : (homeChk.cmd || '') })

    // ② Node（不能自动装，给出准确修复命令）
    const nodeChk = checkNode()
    if (nodeChk.ok) append('[node] ' + nodeChk.detail + '，跳过')
    else append('[node] ' + nodeChk.detail + ' ⇒ ' + nodeChk.cmd)
    steps.push({ id: 'node', ok: nodeChk.ok, skipped: nodeChk.ok, detail: nodeChk.detail, cmd: nodeChk.ok ? '' : (nodeChk.cmd || '') })

    // ③ nodemailer：npm install --omit=dev → 失败回退 pnpm add nodemailer
    let ne = checkNodemailer(pluginDir)
    if (ne.ok) {
      append('[nodemailer] 已安装，跳过：' + ne.detail)
      steps.push({ id: 'nodemailer', ok: true, skipped: true, detail: ne.detail, cmd: '' })
    } else {
      const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      append('[nodemailer] 缺 ⇒ ' + npmCmd + ' install --omit=dev（cwd=' + pluginDir + '）')
      const r1 = await runCmd(npmCmd, ['install', '--omit=dev'], { cwd: pluginDir, timeoutMs: 240000 })
      append('[npm] exit=' + r1.code + ' ok=' + r1.ok + ' timedOut=' + Boolean(r1.timedOut))
      if (r1.error) append('[npm] error=' + r1.error)
      if (r1.stdout) append('[npm:stdout] ' + clip(r1.stdout, 3000))
      if (r1.stderr) append('[npm:stderr] ' + clip(r1.stderr, 3000))
      ne = checkNodemailer(pluginDir)
      if (!ne.ok) {
        const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
        append('[nodemailer] npm 没解决 ⇒ 回退 ' + pnpmCmd + ' add nodemailer')
        const r2 = await runCmd(pnpmCmd, ['add', 'nodemailer'], { cwd: pluginDir, timeoutMs: 240000 })
        append('[pnpm] exit=' + r2.code + ' ok=' + r2.ok + ' timedOut=' + Boolean(r2.timedOut))
        if (r2.error) append('[pnpm] error=' + r2.error)
        if (r2.stdout) append('[pnpm:stdout] ' + clip(r2.stdout, 3000))
        if (r2.stderr) append('[pnpm:stderr] ' + clip(r2.stderr, 3000))
        ne = checkNodemailer(pluginDir)
      }
      append('[nodemailer] 结果 ok=' + ne.ok + ' · ' + ne.detail)
      steps.push({ id: 'nodemailer', ok: ne.ok, skipped: false, detail: ne.detail, cmd: ne.ok ? '' : (ne.cmd || 'npm install --omit=dev') })
    }

    // ④ twitter-cli：pipx install twitter-cli；没有 pipx 就给 pip 的准确命令
    const tw = await checkTwitter(options)
    if (tw.ok) {
      append('[twitter] 已安装，跳过：' + tw.detail)
      steps.push({ id: 'twitter', ok: true, skipped: true, detail: tw.detail, cmd: '' })
    } else {
      const pipx = String(options.pipxBin || '').trim() || 'pipx'
      const pipxPath = await which('pipx')
      if (pipxPath) {
        append('[twitter] 缺 ⇒ ' + pipx + ' install twitter-cli')
        const r = await runCmd(pipxPath || pipx, ['install', 'twitter-cli'], { timeoutMs: 240000 })
        append('[pipx] exit=' + r.code + ' ok=' + r.ok + ' timedOut=' + Boolean(r.timedOut))
        if (r.error) append('[pipx] error=' + r.error)
        if (r.stdout) append('[pipx:stdout] ' + clip(r.stdout, 3000))
        if (r.stderr) append('[pipx:stderr] ' + clip(r.stderr, 3000))
        const tw2 = await checkTwitter(options)
        append('[twitter] 结果 ok=' + tw2.ok + ' · ' + tw2.detail)
        steps.push({ id: 'twitter', ok: tw2.ok, skipped: false, detail: tw2.detail, cmd: tw2.ok ? '' : (tw2.cmd || 'pipx install twitter-cli') })
      } else {
        append('[twitter] 缺，且没有 pipx ⇒ 请手工跑 pip install --user twitter-cli')
        steps.push({
          id: 'twitter', ok: false, skipped: false,
          detail: '没有 pipx，不能一键装 twitter-cli（' + tw.detail + '）',
          cmd: 'pip install --user twitter-cli',
        })
      }
    }

    // ⑤ 插件文件（不能自动修）
    const filesChk = checkFiles(pluginDir)
    if (filesChk.ok) append('[files] ' + filesChk.detail + '，跳过')
    else append('[files] ' + filesChk.detail)
    steps.push({ id: 'files', ok: filesChk.ok, skipped: filesChk.ok, detail: filesChk.detail, cmd: filesChk.ok ? '' : (filesChk.cmd || '') })

    const checks = await checkDeps(options)
    const durationMs = Date.now() - startedAt
    append('=== install 结束 · ok=' + checks.ok + ' · 用时 ' + durationMs + 'ms · 日志=' + logFile + ' ===')
    const tail = logLines.slice(-80).join('\n')
    return { ok: checks.ok, at: nowIso(), durationMs, log: logFile, logFile, steps, checks, tail }
  } catch (e) {
    append('=== install 崩了（已兜住）：' + String(e && e.stack || e) + ' ===')
    return {
      ok: false,
      at: nowIso(),
      durationMs: Date.now() - startedAt,
      log: logFile,
      logFile,
      error: String(e && e.message || e),
      steps,
      tail: logLines.slice(-80).join('\n'),
    }
  } finally {
    installing = false
  }
}

/** 读 install.log 尾部（给设置页/工具兜底展示） */
export function readInstallLog(home, max = 8000) {
  const dir = String(home || defaultHome())
  for (const f of [join(dir, 'install.log'), join(PLUGIN_DIR, 'install.log')]) {
    try {
      if (!existsSync(f)) continue
      return { ok: true, file: f, text: clip(readFileSync(f, 'utf8'), max) }
    } catch { /* 换下一个 */ }
  }
  return { ok: false, file: join(dir, 'install.log'), text: '' }
}

export { REQUIRED_FILES, PLUGIN_DIR }
