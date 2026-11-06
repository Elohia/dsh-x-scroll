/**
 * dsh-x-scroll —— host 半端（中文名「刷 X」）
 * ============================================================================
 * 职责三件事：
 *   1. 插件内部起那份 MCP（server/mcp_server.mjs），把 X 只读能力注册成 dsh 工具；
 *   2. 每天到点开跑：dsh --profile headless --patch <overlay> <prompt>，
 *      overlay 把 MCP 挂进那一轮，prompt 里塞 duty.md（章程）+ 用户配置；
 *   3. 设置页（client.js）通过 /api/x-duty/* 读写配置、看状态、环境自检、看日报。
 *
 * 数据来源是 twitter-cli（本机 twitter.exe），**只读**：这套 host 与内置 MCP 都没有
 * 点赞 / 转推 / 回复 / 关注 / 发帖能力。
 *
 * 家里（$DSH_HOME/x-duty/）：config.json / state.json / duty.log / out/ / digest/ / seen.md。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

import { spawn } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpClient } from './lib/mcp.mjs'
import { stateDirOf, readJson, writeJson, ensureCharter, charterPath, minutesOf, dayKey, monthKey } from './lib/state.mjs'
import { deliverToSession, sendMail, markdownToHtml, toastNotify, defaultSessionsRoot, readIf } from './lib/deliver.mjs'
import { checkDeps, installDeps, readInstallLog } from './lib/deps.mjs'

export const name = 'x-scroll'
export const inject = ['webServer', 'tools']

/* 默认关注方向（用户在设置页里一行一个改掉就行） */
const DEFAULT_DIRECTIONS = ['AI / agent 与开源', '独立开发 / 出海收款', 'A股工具与数据']

/** 工作区镜像目录的默认值：**留空 = 不镜像**（在设置页里自己填，别把别人的路径写死） */
const DEFAULT_MIRROR = ''

const DEFAULTS = {
  enabled: true,
  runAt: '09:30',
  catchUp: true,
  directions: DEFAULT_DIRECTIONS.join('\n'),
  perDirection: 20,
  deepRead: 8,
  sort: 'general',
  readReplies: true,
  reportLevel: 'full',
  mirrorDir: DEFAULT_MIRROR,
  workspace: '',
  headlessProfile: 'headless',
  dshBin: '',
  overlayMcp: true,
  /** twitter.exe 路径；留空由 MCP 自己按 X_TWITTER_BIN / PATH / 默认位置找 */
  twitterBin: '',
  /** 代理；留空由 MCP 自己探测（X_PROXY → 常见端口 → 系统代理） */
  proxy: '',
  // ── 投递（怎么把结果送到你手上）──
  /** off=不投 / latest=投给最近活跃的会话 / fixed=投给 sessionId 指定的那个 */
  sessionTarget: 'off',
  sessionId: '',
  /** 会话里让 AI 用几句话把要点说出来（而不是把全文塞进去） */
  sessionSpeak: true,
  deliverMail: false,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: '',
  smtpFrom: '',
  mailTo: '',
  /** ⚠️ 只有 DSH credentials 服务拿不到时才用这个明文兜底 */
  smtpPass: '',
  deliverToast: false,
  // ── 写操作（CONTRACT v0.2）：默认全关；总闸关着时四个单项一律无效（fail-closed）──
  /** 总闸 */
  allowWrite: false,
  allowLike: false,
  allowFollow: false,
  allowReply: false,
  allowPost: false,
  /** 回复/发帖前是否必须 confirm:true */
  replyRequireConfirm: true,
  postRequireConfirm: true,
  /** 每日额度（MCP 侧按台账执行） */
  maxLikesPerDay: 20,
  maxFollowsPerDay: 10,
  maxRepliesPerDay: 5,
  maxPostsPerDay: 3,
  /** 回复正文下限（治"说得好"），以及回复里是否允许放链接 */
  replyMinChars: 15,
  replyAllowLinks: false,
  /** 长文上限（加权字符）：>280 自动走长帖通道；非 Premium 账号改成 280 */
  maxPostWeight: 25000,
  /** 撞到限流/风控信号后冷却多少小时（这期间一律不许再跑） */
  riskCooldownHours: 24,
}

/** SMTP 授权码在 DSH credentials 里的引用名（不写进 config.json） */
const SMTP_REF = 'X_SMTP_PASS'

export function apply(ctx, config) {
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const stateDir = stateDirOf(ctx)
  const cfgFile = join(stateDir, 'config.json')
  const logFile = join(stateDir, 'duty.log')
  const outDir = join(stateDir, 'out')
  const digestDir = join(stateDir, 'digest')
  const seenFile = join(stateDir, 'seen.md')
  const stateFile = join(stateDir, 'state.json')
  const serverScript = join(pluginDir, 'server', 'mcp_server.mjs')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(digestDir, { recursive: true })
  try { if (!existsSync(seenFile)) writeFileSync(seenFile, '# 判重表：进过日报的推文 ID（一行一条）\n', 'utf8') } catch { /* 无所谓 */ }

  const myVer = () => {
    try { return String(JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '') } catch { return '' }
  }

  const log = (msg) => {
    const line = new Date().toISOString() + '  ' + msg
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 写不进去也不致命 */ }
    try { ctx.logger?.info?.('[x-duty] ' + msg) } catch { /* 没有 logger 就算了 */ }
  }

  for (const n of hostDeps.notes) log(n)

  /* ─────────────── 配置 ───────────────
   * ⚠️ apply 传进来的 config 字段值**不保证是标量**；对象是真值，守卫会全部失效
   *    ⇒ 定时器回调里抛 TypeError ⇒ 整个宿主被杀。
   *    ⇒ ① 逐字段按默认值类型挑一遍；② 定时器回调绝不让异常外冒。
   */
  const normalize = (src, base) => {
    const out = { ...base }
    for (const k of Object.keys(base)) {
      const v = src?.[k]
      if (v === undefined || v === null) continue
      if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
      else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
      else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
      else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
    }
    return out
  }

  /** 数字字段：有限数就走夹逼，否则保留默认值 */
  const intOf = (v, dflt, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(min, Math.min(Math.round(n), max)) : dflt
  }

  const clampPatch = (patch) => {
    const p = { ...patch }
    if ('perDirection' in p) p.perDirection = Math.max(5, Math.min(Number(p.perDirection) || 20, 50))
    if ('deepRead' in p) p.deepRead = Math.max(1, Math.min(Number(p.deepRead) || 8, 30))
    if ('reportLevel' in p) p.reportLevel = ['full', 'brief'].includes(String(p.reportLevel)) ? String(p.reportLevel) : 'full'
    if ('sort' in p) p.sort = ['general', 'latest', 'popular'].includes(String(p.sort)) ? String(p.sort) : 'general'
    if ('runAt' in p) p.runAt = minutesOf(p.runAt) === null ? DEFAULTS.runAt : String(p.runAt)
    if ('sessionTarget' in p) p.sessionTarget = ['off', 'latest', 'fixed'].includes(String(p.sessionTarget)) ? String(p.sessionTarget) : 'off'
    if ('smtpPort' in p) p.smtpPort = Math.max(1, Math.min(Number(p.smtpPort) || 465, 65535))
    if ('riskCooldownHours' in p) p.riskCooldownHours = Math.max(1, Math.min(Number(p.riskCooldownHours) || 24, 240))
    if ('smtpSecure' in p) p.smtpSecure = Boolean(p.smtpSecure)
    if ('deliverMail' in p) p.deliverMail = Boolean(p.deliverMail)
    if ('deliverToast' in p) p.deliverToast = Boolean(p.deliverToast)
    if ('sessionSpeak' in p) p.sessionSpeak = Boolean(p.sessionSpeak)
    if ('readReplies' in p) p.readReplies = Boolean(p.readReplies)
    if ('twitterBin' in p) p.twitterBin = String(p.twitterBin || '').trim()
    if ('proxy' in p) p.proxy = String(p.proxy || '').trim()
    // ── 写操作（v0.2）：布尔一律强转；额度/字数夹逼 ──
    if ('allowWrite' in p) p.allowWrite = Boolean(p.allowWrite)
    if ('allowLike' in p) p.allowLike = Boolean(p.allowLike)
    if ('allowFollow' in p) p.allowFollow = Boolean(p.allowFollow)
    if ('allowReply' in p) p.allowReply = Boolean(p.allowReply)
    if ('allowPost' in p) p.allowPost = Boolean(p.allowPost)
    if ('replyRequireConfirm' in p) p.replyRequireConfirm = Boolean(p.replyRequireConfirm)
    if ('postRequireConfirm' in p) p.postRequireConfirm = Boolean(p.postRequireConfirm)
    if ('replyAllowLinks' in p) p.replyAllowLinks = Boolean(p.replyAllowLinks)
    // 上下限与 lib/writegate.mjs 的 asInt 保持一致（否则设置页存进去的数会被 MCP 再夹一次）
    if ('maxLikesPerDay' in p) p.maxLikesPerDay = intOf(p.maxLikesPerDay, DEFAULTS.maxLikesPerDay, 0, 500)
    if ('maxFollowsPerDay' in p) p.maxFollowsPerDay = intOf(p.maxFollowsPerDay, DEFAULTS.maxFollowsPerDay, 0, 500)
    if ('maxRepliesPerDay' in p) p.maxRepliesPerDay = intOf(p.maxRepliesPerDay, DEFAULTS.maxRepliesPerDay, 0, 500)
    if ('maxPostsPerDay' in p) p.maxPostsPerDay = intOf(p.maxPostsPerDay, DEFAULTS.maxPostsPerDay, 0, 100)
    if ('replyMinChars' in p) p.replyMinChars = intOf(p.replyMinChars, DEFAULTS.replyMinChars, 0, 280)
    if ('maxPostWeight' in p) p.maxPostWeight = intOf(p.maxPostWeight, DEFAULTS.maxPostWeight, 1, 25000)
    if ('headlessProfile' in p) p.headlessProfile = String(p.headlessProfile || 'headless').trim() || 'headless'
    if ('directions' in p) {
      const lines = String(p.directions || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12)
      p.directions = lines.join('\n')
    }
    return p
  }

  let cfg = normalize(readJson(cfgFile, {}), normalize(config, { ...DEFAULTS }))
  const refreshCfg = () => { cfg = normalize({ ...cfg, ...readJson(cfgFile, {}) }, { ...DEFAULTS }); return cfg }
  const saveCfg = (patch) => {
    const next = normalize({ ...cfg, ...clampPatch(patch) }, { ...DEFAULTS })
    writeJson(cfgFile, next)
    cfg = next
    return cfg
  }
  const directions = () => String(cfg.directions || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

  /* 状态目录里该有的东西一次铺齐：config / state / seen（duty.log 第一次写日志就有） */
  try { if (!existsSync(cfgFile)) writeJson(cfgFile, cfg) } catch { /* 无所谓 */ }
  try { if (!existsSync(stateFile)) writeJson(stateFile, {}) } catch { /* 无所谓 */ }

  const reportPath = (day = dayKey()) => join(outDir, (day || dayKey()) + '.md')
  const mirrorPath = (day = dayKey()) => {
    const dir = String(cfg.mirrorDir || '').trim()
    return dir ? join(dir, (day || dayKey()) + '.md') : ''
  }

  /**
   * 今天挑了几条：只数「值得回的帖」里的 ### 推文ID 标题行。
   * 推文 ID 是纯数字（也容忍短横线/下划线），必须是**单独一行的一个 token**，
   * 免得把「### 1. 某某事件」这种子标题也数进去。
   */
  const countPickedToday = () => {
    try {
      const txt = readFileSync(reportPath(), 'utf8')
      const at = txt.search(/^#{2,3}\s+.*值得回/m)
      const part = at >= 0 ? txt.slice(at) : txt
      return (part.match(/^###\s+[0-9A-Za-z_-]{6,40}\s*$/gm) || []).length
    } catch { return 0 }
  }

  /* ─────────────── MCP 子进程（host 侧） ─────────────── */

  const nodeCmd = () => process.execPath
  const mcpEnv = (extra = {}) => {
    const bin = String(cfg.twitterBin || '').trim()
    const proxy = String(cfg.proxy || '').trim()
    return {
      ...process.env,
      X_DUTY_HOME: stateDir,
      ...(bin ? { X_TWITTER_BIN: bin } : {}),
      ...(proxy ? { X_PROXY: proxy } : {}),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...extra,
    }
  }

  let mcp = null
  let mcpStarting = null
  const ensureMcp = async () => {
    if (mcp?.running) return mcp
    if (mcpStarting) return mcpStarting
    mcpStarting = (async () => {
      if (!existsSync(serverScript)) throw new Error('缺文件：' + serverScript)
      const client = new McpClient({
        command: nodeCmd(),
        args: [serverScript],
        cwd: pluginDir,
        env: mcpEnv(),
        log,
      })
      await client.start()
      mcp = client
      return client
    })()
    try { return await mcpStarting } finally { mcpStarting = null }
  }
  const call = async (toolName, args, opts) => {
    const client = await ensureMcp()
    return client.call(toolName, args, opts)
  }
  const stopMcp = () => { try { mcp?.stop() } catch { /* 已停 */ }; mcp = null }

  /* ─────────────── 登录/可用性标记 ─────────────── */

  const loginFile = join(stateDir, 'login.json')
  /**
   * 环境门禁（跑一轮之前）：x_status 成功 + x_whoami 拿到 handle 才算可用。
   * 凭据来自 HKCU\Environment 的 TWITTER_AUTH_TOKEN / TWITTER_CT0（MCP 只注入子进程 env，
   * 这里**绝不打印、绝不落盘**）。门禁不过就不开跑，写一份说明日报。
   */
  const markLoggedIn = (r) => {
    try { writeJson(loginFile, { at: new Date().toISOString(), handle: String(r?.handle || ''), name: String(r?.name || ''), followers: Number(r?.followers ?? 0) }) } catch (e) { log('写账号标记失败：' + (e?.message ?? e)) }
  }
  const loginInfo = () => readJson(loginFile, null)

  /* ─────────────── 风控冷却（熔断） ───────────────
   * 规矩：**抓取端看到限流/风控信号就留痕 → 宿主记账 → 冷却期内一律不许再跑**。
   * ⚠️ 这不是"伪装"，是"撞了墙就别再撞"。
   */
  const riskFile = join(stateDir, 'risk.json')
  const riskSignalsFile = join(stateDir, 'risk-signals.jsonl')
  const riskState = () => readJson(riskFile, { pauseUntil: 0 })
  const cooldownLeftMs = () => Math.max(0, Number(riskState().pauseUntil || 0) - Date.now())
  const fmtLeft = (ms) => {
    const h = Math.floor(ms / 3600000)
    const m = Math.round((ms % 3600000) / 60000)
    return h > 0 ? h + ' 小时 ' + m + ' 分钟' : m + ' 分钟'
  }
  const setPause = (hours, reason, extra = {}) => {
    const until = Date.now() + Math.max(0, hours) * 3600_000
    writeJson(riskFile, { ...riskState(), ...extra, pauseUntil: until, reason, at: new Date().toISOString() })
    return riskState()
  }
  const clearPause = (why) => {
    writeJson(riskFile, { ...riskState(), pauseUntil: 0, clearedAt: new Date().toISOString(), clearedNote: String(why || '') })
    log('风控冷却已手动解除')
    return riskState()
  }
  /** 把抓取端攒下的风险信号消费掉，并据此开启冷却 */
  const consumeRiskSignals = () => {
    let lines = []
    try { lines = readFileSync(riskSignalsFile, 'utf8').split('\n').filter(Boolean) } catch { return null }
    if (!lines.length) return null
    let last = null
    try { last = JSON.parse(lines[lines.length - 1]) } catch { last = { kind: 'unknown' } }
    try { writeFileSync(riskSignalsFile, '', 'utf8') } catch { /* 清不掉也没关系 */ }
    const hours = Math.max(1, Math.min(Number(cfg.riskCooldownHours) || 24, 240))
    setPause(hours, '风控信号：' + (last?.kind || 'unknown'), { lastSignal: last })
    log('⚠️ 检测到风控信号（' + (last?.kind || 'unknown') + '：' + String(last?.detail || '').slice(0, 60) + '）⇒ 冷却 ' + hours + ' 小时')
    return { signal: last, hours }
  }

  /* ─────────────── 日报摘要（按章程五节抽） ─────────────── */

  const summarize = (md, { file = '', mirror = '' } = {}) => {
    const text = String(md || '')
    const lines = text.split(/\r?\n/)
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/)
    const date = dateMatch ? dateMatch[1] : ''

    /** 取某个标题下的条目（到同级或更高级标题为止）；子弹行与子标题都算 */
    const section = (re) => {
      let start = -1
      let lvl = 6
      for (let i = 0; i < lines.length; i++) {
        const h = lines[i].match(/^(#{1,6})\s+(.+)$/)
        if (h && re.test(h[2])) { start = i; lvl = h[1].length; break }
      }
      if (start < 0) return []
      const out = []
      for (let i = start + 1; i < lines.length; i++) {
        const h = lines[i].match(/^(#{1,6})\s+(.+)$/)
        if (h && h[1].length <= lvl) break
        const li = lines[i].match(/^[-*]\s+(.+)$/)
        if (li) out.push(li[1].trim())
        else if (h) out.push(h[2].trim())
      }
      return out
    }

    const oneLiner = (() => {
      const c = section(/今日一句话|一句话/)
      if (c.length) return c[0].replace(/^⚠️?\s*/, '')
      // 兜底：章程若把「今日一句话」写成普通段落（不是子弹），取该标题后第一行正文
      let on = false
      let lvl = 6
      for (const raw of lines) {
        const h = raw.match(/^(#{1,6})\s+(.+)$/)
        if (h) {
          if (on && h[1].length <= lvl) break
          if (!on && /今日一句话|一句话/.test(h[2])) { on = true; lvl = h[1].length }
          continue
        }
        if (!on) continue
        const t = raw.trim()
        if (t) return t.replace(/^[-*]\s+/, '').replace(/^>\s*/, '')
      }
      for (const l of lines) {
        const m = l.match(/^>\s*(?:\*\*)?一句话总结(?:\*\*)?[:：]\s*(.+)$/)
        if (m) return m[1].trim()
      }
      return ''
    })()

    const topics = section(/热点与事件|热点事件|热点主题/)
    const picks = section(/值得回的帖|值得细看/)
    const account = section(/账号数据/)
    const risks = section(/未决与风险/)
    return { date, oneLiner, topics, picks, account, risks, file, mirror, chars: text.length }
  }

  const summaryText = (s) => {
    const out = []
    if (s.oneLiner) out.push(s.oneLiner)
    if (s.topics.length) { out.push('', '热点与事件：'); s.topics.slice(0, 6).forEach((t) => out.push('  · ' + t)) }
    if (s.picks.length) { out.push('', '值得回的帖：' + s.picks.length + ' 条'); s.picks.slice(0, 5).forEach((t) => out.push('  · ' + t)) }
    if (s.risks.length) { out.push('', '未决与风险：'); s.risks.slice(0, 3).forEach((t) => out.push('  · ' + t)) }
    out.push('', '完整日报：', s.mirror ? '  ' + s.mirror : '', s.file ? '  ' + s.file : '')
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }

  /* ─────────────── 投递：会话 / 邮件 / 桌面通知 ─────────────── */

  const sessionsRoot = defaultSessionsRoot()
  const credService = () => { try { return typeof ctx.get === 'function' ? ctx.get('credentials') : undefined } catch { return undefined } }
  /** 设置页要"授权码配没配"，但不能把值读出来 —— 探一次记住 */
  const smtpCache = { configured: false }

  /** SMTP 授权码：优先 DSH credentials（加密托管），拿不到才退到 config.json */
  const smtpPass = async () => {
    try {
      const c = credService()
      if (c && typeof c.resolve === 'function') {
        const r = await c.resolve(SMTP_REF)
        if (r?.value) { smtpCache.configured = true; return { pass: r.value, from: 'credentials' } }
      }
    } catch (e) { log('读 credentials 失败：' + (e?.message ?? e)) }
    smtpCache.configured = Boolean(cfg.smtpPass)
    return { pass: String(cfg.smtpPass || ''), from: cfg.smtpPass ? 'config.json（明文）' : '' }
  }
  const saveSmtpPass = async (v) => {
    const c = credService()
    if (c && typeof c.set === 'function') {
      await c.set(SMTP_REF, String(v))
      smtpCache.configured = true
      return { ok: true, where: 'credentials', note: '授权码已交给 DSH credentials 服务托管（不落明文）' }
    }
    saveCfg({ smtpPass: String(v) })
    smtpCache.configured = Boolean(v)
    return { ok: true, where: 'config.json', note: '⚠️ 这个宿主没有 credentials 服务，授权码只能明文存进 config.json' }
  }

  /** 组装"投进会话"的那段话（短：要点 + 让人说两句，不塞全文） */
  const sessionMessage = (s) => {
    const head = '📮 自动投递 · X 日报' + (s.date ? '（' + s.date + '）' : '')
    const lines = [head, '']
    if (s.oneLiner) lines.push(s.oneLiner)
    if (s.topics.length) { lines.push('', '热点与事件：'); s.topics.slice(0, 5).forEach((t) => lines.push('· ' + t)) }
    if (s.picks.length) lines.push('', '值得回的帖：' + s.picks.length + ' 条')
    if (s.file) lines.push('', '完整日报：' + s.file)
    if (cfg.sessionSpeak) {
      lines.push('', '请用 3~5 句话跟我说清楚今天最值得知道的是什么。不要复述全文、不要列清单、不要说"这是一条自动投递"。')
    }
    return lines.join('\n')
  }

  /**
   * 跑完一轮之后的投递。三个通道各自独立，谁失败都不影响别人。
   * ⚠️ 全部包在 try/catch 里：这是 child.on('exit') 的回调，抛异常会杀掉整个宿主。
   */
  const deliverReport = async (reason = 'round', { only = '', day = dayKey() } = {}) => {
    const result = { at: new Date().toISOString(), reason, channels: {} }
    try {
      refreshCfg()
      const report = readIf(reportPath(day))
      const st = readJson(stateFile, {})
      if (!report) {
        result.skipped = '今天没有日报文件'
        result.notes = st.skipped === 'unavailable' ? '这一轮因为环境不可用被跳过' : '这一轮没写出报告'
      }
      const s = summarize(report || '', { file: reportPath(day), mirror: mirrorPath(day) })
      if (!report) { s.date = day; s.oneLiner = result.notes || '这一轮没有生成日报' }

      // ① 会话
      if (only ? only === 'session' : (cfg.sessionTarget && cfg.sessionTarget !== 'off')) {
        try {
          const wanted = cfg.sessionTarget === 'fixed' ? String(cfg.sessionId || '') : ''
          result.channels.session = deliverToSession(ctx, {
            sessionsRoot,
            text: sessionMessage(s),
            sessionId: wanted,
            strict: cfg.sessionTarget === 'fixed',
          })
        } catch (e) { result.channels.session = { ok: false, why: String(e?.message ?? e) } }
      }

      // ② 邮件
      if (only ? only === 'mail' : cfg.deliverMail) {
        try {
          const { pass, from: passFrom } = await smtpPass()
          const mail = await sendMail({
            host: cfg.smtpHost,
            port: cfg.smtpPort,
            secure: cfg.smtpSecure,
            user: cfg.smtpUser,
            pass,
            from: cfg.smtpFrom || cfg.smtpUser,
            to: cfg.mailTo,
            subject: ('X 日报 ' + (s.date || '') + (s.oneLiner ? ' ｜ ' + s.oneLiner.slice(0, 28) : '')).trim(),
            text: summaryText(s) + (report ? '\n\n（完整日报见附件）' : ''),
            html: markdownToHtml(report || summaryText(s)),
            attachments: report ? [{ filename: 'x-daily-' + (s.date || dayKey()) + '.md', content: report, contentType: 'text/markdown' }] : [],
          })
          result.channels.mail = { ...mail, passFrom }
        } catch (e) { result.channels.mail = { ok: false, why: String(e?.message ?? e) } }
      }

      // ③ 桌面通知（兜底）
      if (only ? only === 'toast' : cfg.deliverToast) {
        try {
          result.channels.toast = toastNotify({
            title: 'X 日报好了',
            body: (s.oneLiner || '日报已生成').slice(0, 120),
            spawn,
            log,
          })
        } catch (e) { result.channels.toast = { ok: false, why: String(e?.message ?? e) } }
      }

      const tried = Object.entries(result.channels)
      result.ok = tried.length ? tried.some(([, v]) => v?.ok) : false
      if (!tried.length) result.skipped = result.skipped || '三个通道都关着（设置里可以开）'
      log('投递（' + reason + '）：' + (tried.length ? tried.map(([k, v]) => k + '=' + (v?.ok ? 'ok' : 'fail')).join(' ') : '没有通道开启'))
      try { writeJson(stateFile, { ...readJson(stateFile, {}), lastDelivery: result }) } catch { /* 无所谓 */ }
    } catch (e) {
      log('投递整体失败（已兜住）：' + (e?.stack ?? e))
      result.error = String(e?.message ?? e)
    }
    return result
  }

  /* ─────────────── 环境自检 / 可用性门禁 ─────────────── */

  const selfcheck = async () => {
    refreshCfg()
    const out = {
      ok: false,
      at: new Date().toISOString(),
      cli: { bin: String(cfg.twitterBin || ''), version: '' },
      proxy: { url: String(cfg.proxy || ''), source: '' },
      cred: { ok: false },
      account: { needLogin: true },
      home: stateDir,
      version: myVer(),
    }
    // ① 通道体检（x_status）：给版本 / 代理 / 凭据做参考；坏代理时它自己返回 ok:false，不抛
    let st = null
    try {
      st = await call('x_status', {}, { timeoutMs: 90000 })
      if (st && typeof st === 'object') {
        out.status = st
        if (st.cli && typeof st.cli === 'object') out.cli = { ...out.cli, ...st.cli }
        if (st.proxy && typeof st.proxy === 'object') out.proxy = { ...out.proxy, ...st.proxy }
        if (st.cred && typeof st.cred === 'object') out.cred = { ...out.cred, ...st.cred }
        if (st.account && typeof st.account === 'object') out.account = { ...out.account, ...st.account }
        if (st.error) out.error = String(st.error)
      }
    } catch (e) { out.error = String(e?.message ?? e) }

    // ② 账号才是最终判据：x_whoami 拿得到 handle ⇒ 代理 + 凭据 + 登录三件事同时成立。
    //    （x_status.ok 是派生值，代理探测抖一下不该把整轮拦住）
    try {
      const me = await call('x_whoami', {}, { timeoutMs: 90000 })
      if (me?.ok) {
        out.whoami = me
        out.account = {
          ...out.account,
          needLogin: false,
          handle: String(me.handle || ''),
          name: String(me.name || ''),
          followers: Number(me.followers ?? 0),
          following: Number(me.following ?? 0),
          tweets: Number(me.tweets ?? 0),
          verified: Boolean(me.verified),
        }
        out.ok = true
        markLoggedIn(me)
      } else {
        out.account = { ...out.account, needLogin: true }
        out.error = out.error || String(me?.error || 'x_whoami 失败')
      }
    } catch (e) { out.error = out.error || String(e?.message ?? e) }
    return out
  }

  /** 门禁失败时归因：优先看错误文本，再看 status 字段（不同 MCP 版本返回不完全一样） */
  const gateStage = (sc) => {
    if (sc?.ok) return ''
    const e = String(sc?.error || sc?.status?.error || '')
    if (/代理|proxy/i.test(e)) return 'proxy'
    if (/凭据|TWITTER_AUTH_TOKEN|CT0|credential/i.test(e)) return 'cred'
    if (sc?.account?.needLogin) return 'account'
    return 'status'
  }
  const gateReason = (sc) => {
    const stage = gateStage(sc)
    if (stage === 'proxy') return '代理不可用：twitter-cli 连不出去（设置页填一个能用的代理，或在 X_PROXY 里给）'
    if (stage === 'cred') return '凭据没读到：TWITTER_AUTH_TOKEN / TWITTER_CT0 不在进程环境或 HKCU\Environment 里'
    if (stage === 'account') return '凭据失效或未登录：x_whoami 拿不到账号'
    return String(sc?.error || 'X 环境不可用').split(/\r?\n/)[0].slice(0, 300)
  }

  /* ─────────────── 依赖自检 / 安装 ─────────────── */

  const depOptions = () => {
    refreshCfg()
    return { pluginDir, home: stateDir, twitterBin: String(cfg.twitterBin || '').trim() }
  }

  let installingDeps = false
  const doInstallDeps = async () => {
    if (installingDeps) return { ok: false, busy: true, error: '已经有一个安装在跑，等它结束' }
    installingDeps = true
    try { return await installDeps(depOptions(), log) }
    catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    finally { installingDeps = false }
  }

  /* ─────────────── 工具 ─────────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }

  /** 宿主要的是"无损 JSON"：塞函数/循环引用/类实例会报 value is not lossless JSON */
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  const localStatus = () => {
    refreshCfg()
    const today = dayKey()
    const st = readJson(stateFile, {})
    return {
      ok: true,
      today,
      ranToday: st.lastRunDay === today,
      pickedToday: countPickedToday(),
      autoRun: Boolean(cfg.enabled),
      runAt: cfg.runAt,
      directions: directions(),
      perDirection: cfg.perDirection,
      deepRead: cfg.deepRead,
      sort: cfg.sort,
      readReplies: cfg.readReplies,
      report: reportPath(today),
      reportExists: existsSync(reportPath(today)),
      mirror: mirrorPath(today),
      lastLogin: loginInfo(),
      lastDelivery: st.lastDelivery || null,
      delivery: {
        session: cfg.sessionTarget,
        mail: cfg.deliverMail,
        toast: cfg.deliverToast,
      },
      risk: {
        inCooldown: cooldownLeftMs() > 0,
        cooldownLeftMs: cooldownLeftMs(),
        pauseUntil: riskState().pauseUntil || 0,
        reason: riskState().reason || '',
        lastSignal: riskState().lastSignal || null,
      },
      home: stateDir,
      version: myVer(),
    }
  }

  /** 写操作本地视图（开关以 config 为唯一事实源；今日用量由 MCP 台账补） */
  const localWriteView = () => ({
    allowWrite: Boolean(cfg.allowWrite),
    allowLike: Boolean(cfg.allowLike),
    allowFollow: Boolean(cfg.allowFollow),
    allowReply: Boolean(cfg.allowReply),
    allowPost: Boolean(cfg.allowPost),
    today: {
      likes: 0, follows: 0, replies: 0, posts: 0,
      limits: { likes: cfg.maxLikesPerDay, follows: cfg.maxFollowsPerDay, replies: cfg.maxRepliesPerDay, posts: cfg.maxPostsPerDay },
    },
  })

  /** 写操作状态：开关来自 config；今日已用/上限问 MCP（拿不到就回 0，不编数字） */
  const writeStatus = async () => {
    refreshCfg()
    const write = localWriteView()
    /** MCP 的台账用 like/follow/reply/post（单数），这里统一成复数；两边形状不同也吃得下 */
    const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt }
    const countsOf = (src, fallback) => ({
      likes: num(src?.likes ?? src?.like, fallback.likes),
      follows: num(src?.follows ?? src?.follow, fallback.follows),
      replies: num(src?.replies ?? src?.reply, fallback.replies),
      posts: num(src?.posts ?? src?.post, fallback.posts),
    })
    try {
      const ws = await call('x_write_status', {}, { timeoutMs: 30000 })
      if (ws && typeof ws === 'object') {
        const used = ws.used && typeof ws.used === 'object' ? ws.used : null
        const today = ws.today && typeof ws.today === 'object' ? ws.today : null
        const todaySrc = today ? { ...(used || {}), ...today } : used
        if (todaySrc) write.today = { ...write.today, ...countsOf({ ...write.today, ...todaySrc }, write.today) }
        if (todaySrc && todaySrc.date) write.today.date = String(todaySrc.date)
        if (ws.limits && typeof ws.limits === 'object') write.today.limits = countsOf({ ...write.today.limits, ...ws.limits }, write.today.limits)
        if (Array.isArray(ws.recent)) write.ledger = ws.recent.slice(0, 5)
        else if (Array.isArray(ws.ledger)) write.ledger = ws.ledger.slice(0, 5)
        if (ws.require && typeof ws.require === 'object') write.require = ws.require
        if (ws.content && typeof ws.content === 'object') write.content = ws.content
        if (typeof ws.configOk === 'boolean') write.configOk = ws.configOk
        // 开关以 config 为事实源；这里只报「两边不一致」，方便排查
        const flags = ['allowWrite', 'allowLike', 'allowFollow', 'allowReply', 'allowPost']
        const mismatch = flags.filter((k) => typeof ws[k] === 'boolean' && ws[k] !== write[k])
        if (mismatch.length) write.mismatch = mismatch
        if (ws.ok === false && ws.error) write.error = String(ws.error)
      }
    } catch (e) { write.error = String(e?.message ?? e) }
    return write
  }

  /** 宿主侧 fail-closed：总闸/单项开关关着就绝不把请求发给 MCP（MCP 里还有一遍同样的闸门） */
  const WRITE_LABEL = { Like: '点赞', Follow: '关注', Reply: '回复', Post: '发帖' }
  const writeGate = (kind) => {
    refreshCfg()
    if (!cfg.allowWrite) return { ok: false, blocked: 'allowWrite', reason: '写操作总闸关着：先到设置页「写操作」打开总闸' }
    const key = 'allow' + kind
    if (!cfg[key]) return { ok: false, blocked: key, reason: '写操作开关「' + (WRITE_LABEL[kind] || kind) + '」关着' }
    return null
  }

  tool({
    name: 'x_status',
    description: '看「刷 X」今天的状态与可用性：twitter-cli 版本、代理、凭据、账号、跑没跑、日报在哪、下次什么时候跑。\n'
      + '另外返回 write 块：写操作四个开关 + 今日已用/上限（来源 x_write_status），动手前先看它。\n'
      + '返回 ok=false 就说明现在不能跑（看 error：代理 / 凭据 / 登录）。',
    parameters: {},
    async execute() {
      let live = null
      try { live = await call('x_status', {}, { timeoutMs: 60000 }) } catch (e) { live = { ok: false, error: String(e?.message ?? e) } }
      const write = await writeStatus()
      return { ...safe(live), ...localStatus(), write, ok: Boolean(live?.ok) }
    },
  })

  tool({
    name: 'x_whoami',
    description: '看当前登录的 X 账号：handle / 昵称 / 粉丝 / 关注 / 推文数 / 是否蓝V / 注册时间。',
    parameters: {},
    async execute() { return call('x_whoami', {}, { timeoutMs: 90000 }) },
  })

  tool({
    name: 'x_search',
    description: '按关键词搜 X 帖子，返回 id / 链接 / 作者 / 粉丝 / 是否蓝V / 正文 / 赞·回·转 / 时间。\n'
      + '⚠️ 刷一轮的用法：每个方向搜一次（20 条左右），再挑值得的读全文（x_tweet）—— 别看标题下结论。',
    parameters: {
      query: { type: 'string', description: '搜索词（一个方向一个词）' },
      limit: { type: 'number', description: '返回几条（默认 20，最大 50）' },
      sort: { type: 'string', description: 'general=综合 / latest=最新 / popular=最热' },
    },
    async execute(args) {
      const q = String(args.query ?? '').trim()
      if (!q) return { ok: false, error: 'query 不能为空' }
      const sort = ['general', 'latest', 'popular'].includes(String(args.sort || '')) ? String(args.sort) : String(cfg.sort || 'general')
      return call('x_search', {
        query: q,
        limit: Math.max(1, Math.min(Number(args.limit) || 20, 50)),
        sort,
      }, { timeoutMs: 180000 })
    },
  })

  tool({
    name: 'x_user',
    description: '看一个 X 账号的公开资料：昵称 / bio / 粉丝 / 关注 / 推文数 / 是否蓝V / 注册时间 / 主页链接。',
    parameters: { handle: { type: 'string', description: '账号 handle（带不带 @ 都行）' } },
    async execute(args) {
      const handle = String(args.handle ?? '').replace(/^@/, '').trim()
      if (!handle) return { ok: false, error: 'handle 不能为空' }
      return call('x_user', { handle }, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_posts',
    description: '拉一个账号最近的帖子（id / 链接 / 正文 / 赞·回·转 / 时间）。判断"这个人在讲什么"就靠它。',
    parameters: {
      handle: { type: 'string', description: '账号 handle' },
      limit: { type: 'number', description: '返回几条（默认 20，最大 50）' },
    },
    async execute(args) {
      const handle = String(args.handle ?? '').replace(/^@/, '').trim()
      if (!handle) return { ok: false, error: 'handle 不能为空' }
      return call('x_posts', { handle, limit: Math.max(1, Math.min(Number(args.limit) || 20, 50)) }, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_tweet',
    description: '读一条推文的全文与指标（赞·回·转·看），以及回复区（作者 / 内容 / 赞 / 时间）。\n'
      + '判断"值不值得回"就靠它：回复区竞争小的优先。',
    parameters: {
      id: { type: 'string', description: '推文 ID' },
      url: { type: 'string', description: '或直接给推文链接' },
    },
    async execute(args) {
      return call('x_tweet', { id: String(args.id ?? ''), url: String(args.url ?? '') }, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_growth',
    description: '取账号的增长数据：粉丝 / 关注 / 推文数 / 是否蓝V / 蓝V粉比例，以及最近 10 条的平均曝光与最高曝光。',
    parameters: {},
    async execute() { return call('x_growth', {}, { timeoutMs: 120000 }) },
  })

  /* ── 写操作（CONTRACT v0.2）：默认全关；宿主与 MCP 各过一遍同样的闸门 ── */

  tool({
    name: 'x_like',
    description: '给一条推文点赞（写操作）。要 **总闸 allowWrite + allowLike** 都开；额度/去重/已赞由 MCP 台账把关。\n'
      + '返回 ok=true，或 {ok:false, blocked:"<闸门>", reason:"中文原因"}。⚠️ 只给真正读过的帖点赞。',
    parameters: {
      id: { type: 'string', description: '推文 ID' },
      confirm: { type: 'boolean', description: '确认执行（配置要求时必填 true）' },
    },
    async execute(args) {
      const gate = writeGate('Like')
      if (gate) return gate
      const id = String(args.id ?? '').trim()
      if (!id) return { ok: false, blocked: 'args', reason: 'id 不能为空' }
      return call('x_like', { id, confirm: Boolean(args.confirm) }, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_follow',
    description: '关注一个 X 账号（写操作）。要 **总闸 allowWrite + allowFollow** 都开；额度/已关注由 MCP 台账把关。\n'
      + '返回 ok=true，或 {ok:false, blocked, reason}。⚠️ 只关注「连续两次看到发同类好帖」的人。',
    parameters: {
      handle: { type: 'string', description: '账号 handle（带不带 @ 都行）' },
      confirm: { type: 'boolean', description: '确认执行（配置要求时必填 true）' },
    },
    async execute(args) {
      const gate = writeGate('Follow')
      if (gate) return gate
      const handle = String(args.handle ?? '').replace(/^@/, '').trim()
      if (!handle) return { ok: false, blocked: 'args', reason: 'handle 不能为空' }
      return call('x_follow', { handle, confirm: Boolean(args.confirm) }, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_reply',
    description: '回复一条推文（写操作）。要 **总闸 allowWrite + allowReply** 都开；MCP 还会过长度/语感/链接/额度/去重闸门。\n'
      + '返回 ok=true，或 {ok:false, blocked, reason}。⚠️ 每条回复必须带一个具体信息（数字/反例/可执行动作）。',
    parameters: {
      id: { type: 'string', description: '要回复的推文 ID' },
      text: { type: 'string', description: '回复正文' },
      confirm: { type: 'boolean', description: '确认执行（replyRequireConfirm 为 true 时必填 true）' },
    },
    async execute(args) {
      const gate = writeGate('Reply')
      if (gate) return gate
      const id = String(args.id ?? '').trim()
      const text = String(args.text ?? '').trim()
      if (!id) return { ok: false, blocked: 'args', reason: 'id 不能为空' }
      if (!text) return { ok: false, blocked: 'args', reason: 'text 不能为空' }
      return call('x_reply', { id, text, confirm: Boolean(args.confirm) }, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_post',
    description: '发一条推文（写操作，含引用转推请用 replyTo）。要 **总闸 allowWrite + allowPost** 都开；MCP 还会过字数/额度/去重闸门。\n'
      + '返回 ok=true + tweet id/url，或 {ok:false, blocked, reason}。⚠️ 只在有实测回执时发。',
    parameters: {
      text: { type: 'string', description: '正文；>280 加权自动走长帖通道（CreateNoteTweet，上限 25000）' },
      confirm: { type: 'boolean', description: '确认执行（postRequireConfirm 为 true 时必填 true）' },
      replyTo: { type: 'string', description: '引用/回复的推文 ID（可省）' },
    },
    async execute(args) {
      const gate = writeGate('Post')
      if (gate) return gate
      const text = String(args.text ?? '').trim()
      if (!text) return { ok: false, blocked: 'args', reason: 'text 不能为空' }
      const payload = { text, confirm: Boolean(args.confirm) }
      const replyTo = String(args.replyTo ?? '').trim()
      if (replyTo) payload.replyTo = replyTo
      return call('x_post', payload, { timeoutMs: 120000 })
    },
  })

  tool({
    name: 'x_write_status',
    description: '看写操作今天能不能动手：四个开关 + 今日已用/上限 + 台账最后 5 条。\n'
      + '写之前先用它自检；返回 ok=false 时看 error，别硬试。',
    parameters: {},
    async execute() {
      try { return await call('x_write_status', {}, { timeoutMs: 60000 }) }
      catch (e) {
        refreshCfg()
        return { ok: false, error: String(e?.message ?? e), write: localWriteView() }
      }
    },
  })

  tool({
    name: 'x_setup',
    description: '依赖自检 / 一键安装。\n'
      + 'mode=check（默认）：逐项看 Node、twitter-cli、nodemailer、家目录可写、插件文件完整，每项给 {ok, detail, fix, cmd}。\n'
      + 'mode=install：装缺的依赖（幂等、写 install.log；只跑 npm/pnpm/pipx，**不碰 X 账号**）。',
    parameters: { mode: { type: 'string', description: 'check | install（默认 check）' } },
    async execute(args) {
      const mode = String(args?.mode || 'check').toLowerCase() === 'install' ? 'install' : 'check'
      if (mode === 'install') return doInstallDeps()
      return checkDeps(depOptions())
    },
  })

  tool({
    name: 'x_run',
    description: '**立刻跑一轮**（不等 09:30）：先过环境门禁（x_status + x_whoami），再起一个 headless 会话，\n'
      + '把 duty.md 交给它去刷、写日报。门禁不过会返回 started=false + error，并写一份说明日报。适合"我现在就想看一份"。',
    parameters: {},
    async execute() {
      const r = await runDuty('manual')
      return { ok: Boolean(r.started), ...r }
    },
  })

  tool({
    name: 'x_config',
    description: '读 / 改「刷 X」的设置。不给 patch 就是读；给了就改。\n'
      + '抓取：enabled, runAt("09:30"), catchUp, directions("一行一个方向"), perDirection(5-50), deepRead(1-30), '
      + 'sort(general|latest|popular), readReplies, reportLevel(full|brief), mirrorDir, workspace, headlessProfile, twitterBin, proxy。\n'
      + '投递：sessionTarget(off|latest|fixed), sessionId, sessionSpeak, deliverMail, smtpHost, smtpPort, smtpSecure, '
      + 'smtpUser, smtpFrom, mailTo, deliverToast。\n'
      + '写操作（默认全关）：allowWrite(总闸), allowLike, allowFollow, allowReply, allowPost, replyRequireConfirm, postRequireConfirm, '
      + 'maxLikesPerDay(0-200), maxFollowsPerDay(0-100), maxRepliesPerDay(0-50), maxPostsPerDay(0-20), replyMinChars(1-500), replyAllowLinks。\n'
      + '⚠️ SMTP 授权码**不要**走这个工具（会明文落盘）；用设置页填，存进 DSH credentials。',
    parameters: { patch: { type: 'object', additionalProperties: true, description: '要改的字段（可省）' } },
    async execute(args) {
      if (args?.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) saveCfg(args.patch)
      const p = await smtpPass()
      return {
        ok: true,
        config: cfg,
        directions: directions(),
        home: stateDir,
        smtpPassConfigured: Boolean(p.pass),
        smtpPassFrom: p.from || '未配置',
      }
    },
  })

  tool({
    name: 'x_bind_session',
    description: '**把日报绑定到「当前这个会话」**：以后每轮跑完就把摘要投进这里，AI 会当场念给你听。\n'
      + '用法：打开你想要收日报的那个会话，在里面说一句「把刷 X 的日报投到这个会话」。\n'
      + '⚠️ 投进去的消息来源是 user，所以每次投递都会让这个会话跑一轮模型（有成本）。',
    parameters: {},
    async execute(_args, exec) {
      refreshCfg()
      const sid = String(exec?.agent?.sessionId || exec?.agent?.id || '')
      if (!sid) {
        return { ok: false, error: '拿不到当前会话 id（这个宿主版本没把 agent 传给工具）—— 请手动在设置里填会话 ID' }
      }
      saveCfg({ sessionTarget: 'fixed', sessionId: sid })
      log('日报会话已绑定到 ' + sid)
      return { ok: true, boundTo: sid, sessionTarget: 'fixed', hint: '以后每轮跑完，摘要就投到这个会话；要取消就去设置里改成「不投」或「最近活跃」' }
    },
  })

  tool({
    name: 'x_deliver',
    description: '把今天（或指定某天）的日报**主动送到你手上**：会话投递 / 邮件 / 桌面通知。\n'
      + 'what = all（按设置三个通道都走）/ session（只投会话）/ mail（只发邮件）/ toast（只弹通知）。\n'
      + '⚠️ 会话投递会在那个会话里**真的跑一轮模型**（消息来源是 user），这是有成本的；邮件走 SMTP（授权码在设置里填）。',
    parameters: {
      what: { type: 'string', description: 'all / session / mail / toast（默认 all）' },
      day: { type: 'string', description: '哪一天（YYYY-MM-DD，默认今天）' },
    },
    async execute(args) {
      refreshCfg()
      const what = ['all', 'session', 'mail', 'toast'].includes(String(args.what || '')) ? String(args.what || '') : 'all'
      const day = String(args.day || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(args.day) : dayKey()
      const file = join(outDir, day + '.md')
      const exists = existsSync(file)
      const r = await deliverReport('manual:' + what, { only: what === 'all' ? '' : what, day })
      return { ok: r.ok, day, reportExists: exists, report: file, ...r }
    },
  })

  /* ─────────────── 找 dsh ─────────────── */

  const resolveDsh = () => {
    const explicit = String(cfg.dshBin || '').trim()
    if (explicit && existsSync(explicit)) return { command: process.execPath, args: [explicit], shell: false }
    const guesses = [
      join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
      '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ].filter(Boolean)
    // 桌面版（Electron）把 dsh 打在应用里
    if (process.resourcesPath) {
      for (const rel of [
        ['app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
        ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'],
      ]) {
        const p = join(process.resourcesPath, ...rel)
        if (existsSync(p)) return { command: process.execPath, args: [p], shell: false }
      }
    }
    for (const g of guesses) if (existsSync(g)) return { command: process.execPath, args: [g], shell: false }
    log('⚠️ 找不到 dsh：桌面版多半不是 npm 全局安装的 ⇒ 请在设置里把「dsh 路径」指到 <应用目录>/…/@deepseek-ai/dsh/lib/bin.js')
    return { command: 'dsh', args: [], shell: true }
  }

  /* ─────────────── 跑一轮 ─────────────── */

  const ensureOverlay = () => {
    if (!cfg.overlayMcp) return null
    const file = join(stateDir, 'headless-overlay.yml')
    const posix = (p) => String(p).replace(/\\/g, '/')
    // 读工具常备；写工具也放进来（真正能不能写由 MCP 的七道闸门按 config 判定，不靠白名单兜底）
    const whitelist = ['x_status', 'x_whoami', 'x_search', 'x_user', 'x_posts', 'x_tweet', 'x_growth',
      'x_like', 'x_follow', 'x_reply', 'x_post', 'x_write_status']
    const bin = String(cfg.twitterBin || '').trim()
    const proxy = String(cfg.proxy || '').trim()
    const yml = [
      '- insert:',
      '    - id: mcp-x-duty',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: x-duty',
      '        transport: stdio',
      "        command: '" + posix(nodeCmd()) + "'",
      '        args:',
      "          - '" + posix(serverScript) + "'",
      '        env:',
      "          X_DUTY_HOME: '" + posix(stateDir) + "'",
      ...(bin ? ["          X_TWITTER_BIN: '" + posix(bin) + "'"] : []),
      ...(proxy ? ["          X_PROXY: '" + proxy + "'"] : []),
      "          X_TOOLS: '" + whitelist.join(',') + "'",
      ...(process.versions.electron ? ["          ELECTRON_RUN_AS_NODE: '1'"] : []),
      '',
    ].join('\n')
    try { writeFileSync(file, yml, 'utf8'); return file } catch (e) { log('写 overlay 失败：' + (e?.message ?? e)); return null }
  }

  const promptFor = () => {
    let duty = charterPath(pluginDir, stateDir)
    try { duty = String(duty).split('<家目录>').join(stateDir) } catch { /* 原样用 */ }
    const dirs = directions()
    const picked = countPickedToday()
    // 使用者的 AGENTS.md（人设）由我们自己读进来喂给它 —— 那一轮 cwd 是插件家，读不到工作区
    let ownerDoc = ''
    try {
      const wsDir = String(cfg.workspace || '').trim()
      const agents = wsDir ? join(wsDir, 'AGENTS.md') : ''
      if (agents && existsSync(agents)) {
        ownerDoc = '\n\n===== 使用者的 AGENTS.md（他写给自己 AI 的准则，**按这个来**）=====\n'
          + readFileSync(agents, 'utf8').slice(0, 6000)
          + '\n===== 设定结束 =====\n'
      }
    } catch { /* 读不到就算了 */ }

    return '你是这个 X 账号的「观察员」，替使用者刷一轮 X（Twitter）。'
      + '\n\n⭐ 硬规矩：**只读**。不许点赞、转推、回复、关注、私信、发帖 —— 工具里也没有这些能力。'
      + ownerDoc
      + '\n\n先读章程 ' + duty + '，严格按里面的要求和输出格式做（日报固定五节：今日一句话 / 热点与事件 / 值得回的帖 / 账号数据 / 未决与风险）。'
      + '\n今天要关注的**方向**（' + dirs.length + ' 个）：' + dirs.map((d, i) => (i + 1) + ') ' + d).join('；')
      + '\n每个方向用 x_search 搜一次，取 ' + (Number(cfg.perDirection) || 20) + ' 条候选（sort=' + (cfg.sort || 'general') + '）；'
      + '全部方向加起来**深读 ' + (Number(cfg.deepRead) || 8) + ' 条**（用 x_tweet 读全文；'
      + (cfg.readReplies ? '把返回里的回复区当评论区看，挑热点/争议的几条' : '这一轮不看回复') + '）。'
      + '\n⭐ 读到"同一件事"被多个账号带起来就算一个**热点事件**；只按数量多的算热点方向 —— 别把一条爆款当趋势。'
      + '\n⭐ 账号数据用 x_growth 取（粉丝 / 涨跌 / 近 10 条曝光），数字必须来自工具返回，不许估。'
      + '\n\n日报写到 ' + reportPath()
      + '（今天已经挑过 ' + picked + ' 条；有上一轮的内容就**追加到末尾**，别覆盖）。'
      + '\n⭐ 「值得回的帖」里**每一条**的第一行写成 ### 推文ID（例如 ### 1234567890123456789）—— 宿主就数这些标题行。'
      + '\n⭐ 归档（给以后检索用，**看过的每一条都要进**，挑中的和跳过的都算）：' + join(digestDir, monthKey() + '.md')
      + ' —— 一行一条：日期 · 推文ID · 作者 · 赞/回/转 · 一句话结论 · 链接（跳过的那条注明理由）。'
      + '\n判重表 = ' + seenFile + '（**就是这个绝对路径**）：已经记过的推文不要再进日报；读不出来/写不进去就在报告里明说。'
      + (mirrorPath()
        ? '\n⭐ 报告写完后再把**同一份内容**写到 ' + mirrorPath() + '（工作区镜像，宿主也会兜底复制一次）。'
        : '')
      + '\n⭐ 报告末尾补一段「本轮口径」：搜了哪些方向、各拿到多少条、深读了几条、跳过几条、有没有失败/限流。'
      + '\n最后用一句话汇报你提炼出的今日最值钱的信息。现在几点了自己看一眼系统时间。'
  }

  let running = false
  const stubReportIfMissing = (code, why) => {
    try {
      const f = reportPath()
      if (existsSync(f)) return
      let tail = ''
      try { tail = readFileSync(logFile, 'utf8').slice(-1500) } catch { /* 无所谓 */ }
      writeFileSync(f, [
        '# X 日报 · ' + dayKey() + ' —— 这一轮没写出报告',
        '',
        '> ⚠️ 那一轮结束了（' + why + '，退出码 ' + code + '），但没有生成正常报告。',
        '> 常见原因：代理断了、凭据失效、或它卡在某个工具上反复重试。下一轮会重来。',
        '> 下面附日志尾部；完整日志在插件家目录的 duty.log。',
        '',
        '~~~',
        String(tail).trim(),
        '~~~',
        '',
      ].join('\n'), 'utf8')
      log('这一轮没写报告 ⇒ 宿主补了一份占位报告')
    } catch (e) { log('补占位报告失败：' + (e?.message ?? e)) }
  }

  /** 门禁没过：不跑那一轮，但写一份说明日报（CONTRACT：失败要写日报说明原因） */
  const writeGateReport = (sc) => {
    try {
      const f = reportPath()
      if (existsSync(f)) return
      const stage = gateStage(sc) || 'status'
      const reason = gateReason(sc)
      writeFileSync(f, [
        '# X 日报 · ' + dayKey() + ' —— 这一轮没跑',
        '',
        '## 1. 今日一句话',
        '本轮**没有开跑**：' + reason,
        '',
        '## 2. 热点与事件',
        '- （未取数：跑一轮之前的环境门禁没过，不拿旧数据凑数）',
        '',
        '## 3. 值得回的帖',
        '- （未取数）',
        '',
        '## 4. 账号数据',
        '- （未取数）',
        '',
        '## 5. 未决与风险',
        '- 门禁阶段：' + stage,
        '- 原因：' + reason,
        '- 处理：设置页 →「环境自检」按提示修代理 / 填 twitter 路径 / 更新 Cookie，再点「现在跑一轮」。',
        '',
        '---',
        '',
        '> 这一轮没有产生 token 消耗；下一轮重试。',
        '',
      ].join('\n'), 'utf8')
      log('门禁没过（' + stage + '）：' + reason)
    } catch (e) { log('写说明日报失败：' + (e?.message ?? e)) }
  }

  const mirrorReport = () => {
    const dest = mirrorPath()
    if (!dest) return
    try {
      const src = reportPath()
      if (!existsSync(src)) return
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
      log('日报已复制到工作区：' + dest)
    } catch (e) { log('复制到工作区失败：' + (e?.message ?? e)) }
  }

  const runDuty = async (why = 'schedule') => {
    try {
      refreshCfg()
      if (running) return { started: false, why, error: '上一轮还在跑' }
      // 🔴 风控冷却期：一律不许跑（连手动也不许，除非先解除冷却）
      const left = cooldownLeftMs()
      if (left > 0) {
        const rs = riskState()
        log('风控冷却中，这一轮不跑（' + why + '）：还剩 ' + fmtLeft(left))
        return {
          started: false, why, cooldown: true, cooldownLeftMs: left, pauseUntil: rs.pauseUntil, reason: rs.reason || '',
          error: '风控冷却中：还剩 ' + fmtLeft(left) + (rs.reason ? '（' + rs.reason + '）' : '') + '。确认账号已经正常后，先在设置页点「解除冷却」。',
        }
      }
      running = true
      // 🔴 可用性门禁：x_status + x_whoami。不过就不开跑，写一份说明日报。
      let sc = null
      try { sc = await selfcheck() } catch (e) { sc = { ok: false, error: String(e?.message ?? e) } }
      if (!sc?.ok) {
        running = false
        const stage = gateStage(sc) || 'status'
        writeGateReport(sc)
        try { writeJson(stateFile, { ...readJson(stateFile, {}), lastRunDay: dayKey(), lastWhy: why, skipped: 'unavailable', gate: { at: new Date().toISOString(), stage, error: gateReason(sc) } }) } catch { /* 无所谓 */ }
        return {
          started: false, why, unavailable: true, stage,
          needLogin: stage === 'account',
          error: gateReason(sc),
        }
      }
      const dsh = resolveDsh()
      const overlay = ensureOverlay()
      const args = [...dsh.args, '--profile', cfg.headlessProfile || 'headless']
      if (overlay) args.push('--patch', overlay)
      args.push(promptFor())
      const cwd = stateDir
      writeJson(stateFile, { ...readJson(stateFile, {}), lastRunDay: dayKey(), lastRunAt: new Date().toISOString(), lastWhy: why })
      log('开跑（' + why + '）：' + dsh.command + ' ' + args.slice(0, 3).join(' ') + ' … cwd=' + cwd)
      const child = spawn(dsh.command, args, {
        cwd,
        shell: dsh.shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: mcpEnv(),
      })
      const pick = (buf) => { try { appendFileSync(logFile, String(buf), 'utf8') } catch { /* 绝不能抛 */ } }
      child.stdout?.on('data', pick)
      child.stderr?.on('data', pick)
      child.on('exit', (code) => {
        running = false
        log('结束（' + why + '，code=' + code + '）')
        stubReportIfMissing(code, why)
        mirrorReport()
        try { writeJson(stateFile, { ...readJson(stateFile, {}), lastExit: code, pickedToday: countPickedToday(), finishedAt: new Date().toISOString() }) } catch { /* 无所谓 */ }
        rotateLogIfBig()
        // 抓取端攒的风险信号：消费掉 → 记账 → 进冷却（连手动跑也要挡住）
        try {
          const r = consumeRiskSignals()
          if (r) log('已进冷却 ' + r.hours + ' 小时（信号 ' + r.signal?.kind + '）')
        } catch (e) { log('消费风险信号失败：' + (e?.message ?? e)) }
        // 投递再等几秒：让模型自己把文件写完 / 镜像复制完再读报告
        const t = setTimeout(() => { Promise.resolve(deliverReport(why)).catch((e) => log('投递异常：' + (e?.message ?? e))) }, 4000)
        t.unref?.()
      })
      child.on('error', (e) => { running = false; log('起不来：' + (e?.message ?? e)) })
      return { started: true, why, profile: cfg.headlessProfile, cwd, log: logFile, report: reportPath() }
    } catch (e) {
      running = false
      log('开跑失败（' + why + '）：' + (e?.stack ?? e))
      return { started: false, why, error: String(e?.message ?? e) }
    }
  }

  const rotateLogIfBig = () => {
    try {
      if (!existsSync(logFile)) return
      if (statSync(logFile).size < 2 * 1024 * 1024) return
      const keep = join(stateDir, 'duty.log.1')
      try { writeFileSync(keep, readFileSync(logFile, 'utf8').slice(-300 * 1024), 'utf8') } catch { /* 无所谓 */ }
      writeFileSync(logFile, '', 'utf8')
    } catch { /* 无所谓 */ }
  }

  /* ─────────────── 每天到点跑 ─────────────── */

  const tick = () => {
    try {
      refreshCfg()
      if (running) return
      // 抓取端可能在某轮里留下了风险信号（比如那一轮崩了没走到 exit）—— 每一跳都收一下
      try { consumeRiskSignals() } catch { /* 无所谓 */ }
      if (cooldownLeftMs() > 0) return      // 冷却期：定时器什么都不做，也不刷日志
      if (!cfg.enabled) return
      const now = new Date()
      const cur = now.getHours() * 60 + now.getMinutes()
      const at = minutesOf(cfg.runAt)
      if (at === null) return
      if (cur < at) return
      const today = dayKey()
      const st = readJson(stateFile, {})
      if (st.lastRunDay === today) return                 // 今天已经处理过
      if (existsSync(reportPath(today))) return            // 今天已经有报告
      if (!cfg.catchUp && cur - at > 20) return            // 错过超过 20 分钟就不补跑
      log('到点了（' + cfg.runAt + '），开跑')
      runDuty('schedule').catch((e) => log('定时这一轮异常（已兜住）：' + (e?.message ?? e)))
    } catch (e) {
      log('定时器这一跳出错（已兜住，不影响宿主）：' + (e?.stack ?? e))
    }
  }

  try {
    const timer = setInterval(tick, 60_000)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer), 'x-duty: 定时器')
    // 起插件时也看一眼（避免 "09:30 那会儿 DSH 没开就永远不跑"）
    setTimeout(tick, 20_000).unref?.()
  } catch (e) { log('定时器没起来：' + (e?.message ?? e)) }

  /* ─────────────── HTTP（设置页用） ─────────────── */

  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { data = ''; finish({}); req.destroy() } })
    req.on('end', () => { try { finish(JSON.parse(data || '{}')) } catch { finish({}) } })
    req.on('error', () => finish({}))
  })

  const statusPayload = () => {
    refreshCfg()
    const today = dayKey()
    const st = readJson(stateFile, {})
    return {
      ok: true,
      version: myVer(),
      today,
      config: cfg,
      directions: directions(),
      report: reportPath(today),
      reportExists: existsSync(reportPath(today)),
      mirror: mirrorPath(today),
      pickedToday: countPickedToday(),
      running,
      lastRunAt: st.lastRunAt || '',
      lastRunDay: st.lastRunDay || '',
      lastLogin: loginInfo(),
      lastDelivery: st.lastDelivery || null,
      guide: st.gate || null,
      risk: {
        inCooldown: cooldownLeftMs() > 0,
        cooldownLeftMs: cooldownLeftMs(),
        cooldownLeftText: cooldownLeftMs() > 0 ? fmtLeft(cooldownLeftMs()) : '',
        pauseUntil: riskState().pauseUntil || 0,
        reason: riskState().reason || '',
        lastSignal: riskState().lastSignal || null,
        cooldownHours: cfg.riskCooldownHours,
      },
      smtpPassConfigured: Boolean(cfg.smtpPass) || smtpCache.configured,
      home: stateDir,
      twitterBin: cfg.twitterBin || '',
      proxy: cfg.proxy || '',
    }
  }

  const handle = async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path === '/api/x-duty/status') return sendJson(res, 200, statusPayload())

    if (req.method === 'POST' && path === '/api/x-duty/config') {
      const body = await readBody(req)
      const patch = body?.patch && typeof body.patch === 'object' ? body.patch : body
      saveCfg(patch || {})
      log('设置已改：' + Object.keys(patch || {}).join(','))
      return sendJson(res, 200, { ok: true, ...statusPayload() })
    }

    if (req.method === 'POST' && path === '/api/x-duty/run') {
      const body = await readBody(req)
      const r = await runDuty(body?.why || 'manual')
      return sendJson(res, 200, { ...statusPayload(), started: Boolean(r.started), run: r, error: r.error || '' })
    }

    if (req.method === 'GET' && path === '/api/x-duty/report') {
      const day = String(url.searchParams.get('day') || dayKey()).replace(/[^0-9-]/g, '') || dayKey()
      const file = join(outDir, day + '.md')
      let text = ''
      let exists = false
      try { exists = existsSync(file); if (exists) text = readFileSync(file, 'utf8').slice(0, 400000) } catch { /* 读不到就给空 */ }
      return sendJson(res, 200, { ok: true, day, exists, file, text })
    }

    // 环境自检：twitter-cli 版本 / 代理 / 凭据 / 账号（原扫码登录区块的替代）
    if (req.method === 'GET' && path === '/api/x-duty/selfcheck') {
      try { return sendJson(res, 200, { ok: true, ...(await selfcheck()) }) }
      catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }) }
    }

    if (req.method === 'POST' && path === '/api/x-duty/open') {
      const body = await readBody(req)
      const what = String(body?.what || 'out')
      const dir = what === 'home' ? stateDir : what === 'digest' ? digestDir : outDir
      if (process.platform !== 'win32') return sendJson(res, 200, { ok: false, error: '这个按钮目前只做了 Windows' })
      const attempts = [
        ['cmd.exe', ['/c', 'start', '', dir]],
        [join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [dir]],
      ]
      let lastErr = ''
      for (const [cmd, args] of attempts) {
        const err = await new Promise((resolve) => {
          let done = false
          let child
          try { child = spawn(cmd, args, { detached: true, stdio: 'ignore' }) } catch (e) { resolve(String(e?.message ?? e)); return }
          child.on('error', (e) => { if (!done) { done = true; resolve(String(e?.message ?? e)) } })
          setTimeout(() => { if (!done) { done = true; try { child.unref() } catch { /* 无所谓 */ } resolve('') } }, 500)
        })
        if (!err) return sendJson(res, 200, { ok: true, opened: dir, via: cmd })
        lastErr = err
      }
      return sendJson(res, 200, { ok: false, error: lastErr, dir })
    }

    // ── 风控冷却 ──
    if (req.method === 'POST' && path === '/api/x-duty/risk/clear') {
      const body = await readBody(req)
      const st = clearPause(String(body?.note || '设置页手动解除'))
      return sendJson(res, 200, { ok: true, risk: st })
    }
    if (req.method === 'POST' && path === '/api/x-duty/risk/pause') {
      const body = await readBody(req)
      const hours = Math.max(1, Math.min(Number(body?.hours) || 24, 240))
      const st = setPause(hours, String(body?.reason || '手动暂停'))
      log('手动进入冷却 ' + hours + ' 小时')
      return sendJson(res, 200, { ok: true, risk: st, hours })
    }

    // ── 投递 ──
    if (req.method === 'POST' && path === '/api/x-duty/deliver/test') {
      const body = await readBody(req)
      const what = ['session', 'mail', 'toast'].includes(String(body?.what || '')) ? String(body.what) : 'mail'
      const r = await deliverReport('test:' + what, { only: what })
      return sendJson(res, 200, { ok: r.ok, what, ...r })
    }

    if (req.method === 'POST' && path === '/api/x-duty/deliver/now') {
      const body = await readBody(req)
      const what = ['all', 'session', 'mail', 'toast'].includes(String(body?.what || '')) ? String(body.what) : 'all'
      const r = await deliverReport('manual', { only: what === 'all' ? '' : what })
      return sendJson(res, 200, { ok: r.ok, what, ...r })
    }

    if (req.method === 'POST' && path === '/api/x-duty/smtp-pass') {
      const body = await readBody(req)
      const pass = String(body?.pass || '')
      if (!pass) return sendJson(res, 200, { ok: false, error: '授权码是空的' })
      try {
        const r = await saveSmtpPass(pass)
        log('SMTP 授权码已保存（' + r.where + '）')
        return sendJson(res, 200, { ...r, configured: true })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    if (req.method === 'POST' && path === '/api/x-duty/smtp-pass/clear') {
      try {
        const c = credService()
        if (c && typeof c.unset === 'function') await c.unset(SMTP_REF)
        saveCfg({ smtpPass: '' })
        smtpCache.configured = false
        return sendJson(res, 200, { ok: true, configured: false })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }

    // ── 依赖自检 / 安装（不碰 X 账号）──
    if (req.method === 'GET' && path === '/api/x-duty/deps') {
      try {
        const r = await checkDeps(depOptions())
        const logs = readInstallLog(stateDir)
        return sendJson(res, 200, { ...r, installLog: logs.file, installLogText: logs.text })
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }) }
    }

    if (req.method === 'POST' && path === '/api/x-duty/install') {
      try {
        const body = await readBody(req)
        if (body && body.what && body.what !== 'deps') return sendJson(res, 200, { ok: false, error: '只做依赖安装（what=deps）' })
        const r = await doInstallDeps()
        return sendJson(res, 200, r)
      } catch (e) { return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) }) }
    }

    return sendJson(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + path })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/x-duty',
      handler: async (req, res) => {
        try { await handle(req, res, new URL(req.url, 'http://127.0.0.1')) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'x-duty: /api/x-duty 路由')
  } catch (e) { log('HTTP 路由没挂上：' + (e?.message ?? e)) }

  try { ensureCharter(pluginDir, stateDir, log) } catch (e) { log('章程没铺好：' + (e?.message ?? e)) }

  ctx.effect(() => () => { try { stopMcp() } catch { /* 收摊 */ } }, 'x-duty: 收 MCP 子进程')
  log('已挂载（家=' + stateDir + '，每天 ' + cfg.runAt + ' 跑，方向=' + directions().length + ' 个，twitter=' + (cfg.twitterBin || '自动找') + '）')
}