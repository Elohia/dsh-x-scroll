/**
 * lib/writegate.mjs —— 写操作的闸门、台账、去重
 * ============================================================================
 * CONTRACT v0.2 的唯一实现点。**所有**写动作（点赞 / 关注 / 回复 / 发帖）都必须先过这里，
 * 顺序固定（少一条都不行）：
 *   ① 总闸 allowWrite  → ② 单项开关 → ③ confirm（按需）→ ④ 当日额度
 *   → ⑤ 去重（台账 / seen）→ ⑥ 内容闸门（仅 reply / post）→ ⑦ 执行 → ⑧ 写台账
 *
 * 核心纪律：
 *   - **默认全关 + fail-closed**：config.json 读不到 / 字段坏 / 布尔值写成字符串，
 *     一律按"关"处理；宁可不做，不许误发。
 *   - 任何一条不过就返回 {ok:false, blocked:'<闸门名>', reason:'中文原因'}，**绝不执行**。
 *   - 台账 $X_DUTY_HOME/write-ledger.jsonl **只追加**；不写凭据；正文只存前 40 个字。
 *   - 去重表 $X_DUTY_HOME/write-seen.json：liked / followed / replied / posted。
 *   - 额度只算**成功**的行（ok:true）；失败/被闸住的不占额度。
 *
 * 为什么不放在 server/mcp_server.mjs 里：宿主以后可能自己调（跑一轮时想先看额度），
 * 闸门逻辑只允许有一份实现。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { log, redact, xHome } from './xcli.mjs'

/* ────────────────────────────── 路径 ────────────────────────────── */

/**
 * 三个文件的落点。全部跟着 X_DUTY_HOME 走（和 host 侧 lib/state.mjs 同一口径）：
 *   config.json         host 写的用户配置（这里只读，**每次现读**，设置页一改就生效）
 *   write-ledger.jsonl  写操作台账（只追加）
 *   write-seen.json     去重表
 * X_CONFIG_FILE 只给自检/测试用（指到临时目录），正常没人设。
 */
export function writePaths() {
  const home = xHome()
  return {
    home,
    config: process.env.X_CONFIG_FILE ? String(process.env.X_CONFIG_FILE) : join(home, 'config.json'),
    ledger: join(home, 'write-ledger.jsonl'),
    seen: join(home, 'write-seen.json'),
  }
}

/* ────────────────────────────── ① 配置（fail-closed） ────────────────────────────── */

/** CONTRACT v0.2 第 1 节的全部写字段 + 默认值（默认全关） */
export const WRITE_DEFAULTS = {
  allowWrite: false,
  allowLike: false,
  allowFollow: false,
  allowReply: false,
  allowPost: false,
  replyRequireConfirm: true,
  postRequireConfirm: true,
  maxLikesPerDay: 20,
  maxFollowsPerDay: 10,
  maxRepliesPerDay: 5,
  maxPostsPerDay: 3,
  replyMinChars: 15,
  replyAllowLinks: false,
  // 长文上限（加权字符）。>280 会走 X 的 CreateNoteTweet 长帖通道（上限 25000）；
  // 非 Premium 账号请改成 280，否则服务端会回 186。
  maxPostWeight: 25000,
}

const asBool = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

const asInt = (v, fallback, lo, hi) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}

/**
 * 读写配置。**每次调用都重新读盘**（设置页一改就生效，不需要重启 MCP），
 * 读不到或解析失败 ⇒ 全默认（全关）。这是"fail-closed"的落点。
 */
export function readWriteConfig() {
  const p = writePaths()
  const out = Object.assign({}, WRITE_DEFAULTS)
  out.configPath = p.config
  out.configOk = false
  try {
    if (!existsSync(p.config)) return out
    const raw = JSON.parse(readFileSync(p.config, 'utf8'))
    if (!raw || typeof raw !== 'object') return out
    out.configOk = true
    out.allowWrite = asBool(raw.allowWrite, WRITE_DEFAULTS.allowWrite)
    out.allowLike = asBool(raw.allowLike, WRITE_DEFAULTS.allowLike)
    out.allowFollow = asBool(raw.allowFollow, WRITE_DEFAULTS.allowFollow)
    out.allowReply = asBool(raw.allowReply, WRITE_DEFAULTS.allowReply)
    out.allowPost = asBool(raw.allowPost, WRITE_DEFAULTS.allowPost)
    out.replyRequireConfirm = asBool(raw.replyRequireConfirm, WRITE_DEFAULTS.replyRequireConfirm)
    out.postRequireConfirm = asBool(raw.postRequireConfirm, WRITE_DEFAULTS.postRequireConfirm)
    out.maxLikesPerDay = asInt(raw.maxLikesPerDay, WRITE_DEFAULTS.maxLikesPerDay, 0, 500)
    out.maxFollowsPerDay = asInt(raw.maxFollowsPerDay, WRITE_DEFAULTS.maxFollowsPerDay, 0, 500)
    out.maxRepliesPerDay = asInt(raw.maxRepliesPerDay, WRITE_DEFAULTS.maxRepliesPerDay, 0, 500)
    out.maxPostsPerDay = asInt(raw.maxPostsPerDay, WRITE_DEFAULTS.maxPostsPerDay, 0, 100)
    out.replyMinChars = asInt(raw.replyMinChars, WRITE_DEFAULTS.replyMinChars, 0, 280)
    out.replyAllowLinks = asBool(raw.replyAllowLinks, WRITE_DEFAULTS.replyAllowLinks)
    out.maxPostWeight = asInt(raw.maxPostWeight, WRITE_DEFAULTS.maxPostWeight, 1, 25000)
  } catch (e) {
    // 文件坏了也要能跑 —— 但不能写，所以保持全关
    log('读 config.json 失败（按全关处理）：' + (e && e.message ? e.message : e))
  }
  return out
}

/* ────────────────────────────── ② 台账（只追加） ────────────────────────────── */

/** 台账行：固定七个字段，顺序固定；不写凭据、不写正文全文 */
function ledgerLine(fields) {
  return {
    ts: fields.ts || new Date().toISOString(),
    action: String(fields.action || ''),
    target: String(fields.target || ''),
    ok: Boolean(fields.ok),
    tweetId: String(fields.tweetId || ''),
    blocked: String(fields.blocked || ''),
    note: String(fields.note || ''),
  }
}

/** 正文摘录：只留前 40 个字，压平空白，顺手过一遍凭据抹除 */
export function excerpt(text, n) {
  const limit = n || 40
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  const cut = chars.length > limit ? chars.slice(0, limit).join('') + '…' : flat
  return redact(cut)
}

export function readLedger() {
  const p = writePaths()
  try {
    if (!existsSync(p.ledger)) return []
    const text = readFileSync(p.ledger, 'utf8')
    const out = []
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s) continue
      try {
        const v = JSON.parse(s)
        if (v && typeof v === 'object') out.push(v)
      } catch { /* 半行/坏行跳过，不能因为一行坏账让整本账读不出来 */ }
    }
    return out
  } catch { return [] }
}

function lastLedger() {
  const all = readLedger()
  return all.length ? all[all.length - 1] : null
}

/**
 * 追加一行台账。**只追加**（appendFileSync），永不改写历史。
 * 被闸住的重复尝试做 60 秒节流：同 action + target + blocked 且上一行就是它 ⇒ 不再追加，
 * 否则模型反复试同一件事会把台账刷成噪音。
 */
export function appendLedger(fields) {
  const entry = ledgerLine(fields)
  const p = writePaths()
  try {
    mkdirSync(p.home, { recursive: true })
    const prev = lastLedger()
    if (prev && !entry.ok && prev.action === entry.action && prev.target === entry.target
      && prev.blocked === entry.blocked && String(prev.blocked)) {
      const dt = Math.abs(new Date(entry.ts).getTime() - new Date(prev.ts).getTime())
      if (Number.isFinite(dt) && dt < 60000) return false
    }
    appendFileSync(p.ledger, JSON.stringify(entry) + '\n', 'utf8')
    return true
  } catch (e) {
    log('写台账失败（不影响本次动作）：' + (e && e.message ? e.message : e))
    return false
  }
}

/* ────────────────────────────── ③ 去重表 ────────────────────────────── */

const SEEN_EMPTY = () => ({ liked: {}, followed: {}, replied: {}, posted: {} })

export function readSeen() {
  const p = writePaths()
  const out = SEEN_EMPTY()
  try {
    if (!existsSync(p.seen)) return out
    const raw = JSON.parse(readFileSync(p.seen, 'utf8'))
    if (!raw || typeof raw !== 'object') return out
    for (const k of ['liked', 'followed', 'replied', 'posted']) {
      if (raw[k] && typeof raw[k] === 'object') out[k] = raw[k]
    }
  } catch { /* 坏了就当空表：宁可多一层台账去重，也别让写操作起不来 */ }
  return out
}

export function writeSeen(seen) {
  const p = writePaths()
  try {
    mkdirSync(p.home, { recursive: true })
    const text = JSON.stringify(seen, null, 2)
    const tmp = p.seen + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    try {
      renameSync(tmp, p.seen)      // Windows 上 rename 会覆盖已存在的目标
    } catch {
      writeFileSync(p.seen, text, 'utf8')
      try { writeFileSync(tmp, '', 'utf8') } catch { /* 无所谓 */ }
    }
    return true
  } catch (e) {
    log('写去重表失败：' + (e && e.message ? e.message : e))
    return false
  }
}

/** 记一条去重（成功后调；ts 只做审计，不做过期） */
export function markSeen(action, key) {
  const seen = readSeen()
  const map = action === 'like' ? seen.liked
    : action === 'follow' ? seen.followed
      : action === 'reply' ? seen.replied
        : seen.posted
  if (!map || !key) return
  map[String(key)] = new Date().toISOString()
  writeSeen(seen)
}

/* ────────────────────────────── ④ 额度（按本地自然日） ────────────────────────────── */

export function dayKey(d) {
  const t = d instanceof Date ? d : new Date(d)
  const pad = (n) => String(n).padStart(2, '0')
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
}

const ACTION_KEYS = { like: 'like', follow: 'follow', reply: 'reply', post: 'post' }
const LIMIT_FIELDS = {
  like: 'maxLikesPerDay', follow: 'maxFollowsPerDay', reply: 'maxRepliesPerDay', post: 'maxPostsPerDay',
}
const ACTION_LABELS = { like: '点赞', follow: '关注', reply: '回复', post: '发帖' }
const SWITCH_FIELDS = {
  like: 'allowLike', follow: 'allowFollow', reply: 'allowReply', post: 'allowPost',
}

/** 今天各动作成功了几个（只数 ok:true 的台账行） */
export function todayCounts(now) {
  const today = dayKey(now || new Date())
  const counts = { date: today, like: 0, follow: 0, reply: 0, post: 0 }
  for (const e of readLedger()) {
    if (!e || e.ok !== true) continue
    let k = ''
    try { k = dayKey(e.ts) } catch { continue }
    if (k !== today) continue
    if (counts[e.action] !== undefined) counts[e.action] += 1
  }
  return counts
}

/* ────────────────────────────── ⑤ 内容闸门（reply / post） ────────────────────────────── */

/** 开头八股黑名单（CONTRACT v0.2 第 3 节；宁可多拦，不许刷"说得好"） */
const BAN_PREFIX = [
  '说得好', '说的好', '说得对', '说得太好了', '学习了', '学到了', '支持', '顶', '赞', '牛',
  '感谢分享', '谢谢分享', '谢谢', '受教了', '受益匪浅', '收藏了', '干货', '好文', '太棒了',
  '厉害了', '确实', '同意', '期待', '有帮助', '前排', '路过', '哈哈', '沙发', 'mark', '同感',
  '正解', '妙啊', '绝了', '好厉害', '大佬', '膜拜', '致敬',
]

/** 去掉开头的空白 / 标点 / 表情，只留正文起点，避免"+1 说得好"这种绕过 */
function stripLeadingNoise(text) {
  return String(text ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim()
}

const URL_RE = /https?:\/\/\S+/gi
const HAS_LINK_RE = /(https?:\/\/|www\.|t\.co\/)/i

/** 字数加权（发帖用）：URL 算 23，CJK / emoji 算 2，其余 1 —— 贴近 X 的计数口径 */
export function weightedLength(text) {
  const s = String(text ?? '')
  const urls = s.match(URL_RE) || []
  const stripped = s.replace(URL_RE, '')
  let n = 0
  for (const ch of stripped) {
    if (/\p{Extended_Pictographic}/u.test(ch)) { n += 2; continue }
    if (/[\u1100-\u11FF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/.test(ch)) { n += 2; continue }
    n += 1
  }
  return n + urls.length * 23
}

/** 纯表情 / 纯符号（没有任何字母或数字） */
function isPureEmoji(text) {
  return !/[\p{L}\p{N}]/u.test(String(text ?? ''))
}

/** 字符 bigram 集合（去空白标点，小写） */
function bigrams(s) {
  const t = String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2))
  return out
}

/** Dice 相似度：0..1（>0.8 视为套话复读） */
function dice(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter += 1
  return (2 * inter) / (a.size + b.size)
}

/** 最近 N 条自己发过的回复（台账里只有前 40 字，够算 bigram 了） */
function recentReplyTexts(n) {
  const out = []
  for (const e of readLedger()) {
    if (e && e.action === 'reply' && e.ok === true && e.note) out.push(String(e.note))
  }
  return out.slice(-(n || 20))
}

/**
 * 内容闸门。返回 null 表示通过；返回字符串 = 拒绝原因。
 * reply：长度 / 八股开头 / 纯表情 / 链接 / 与自己最近 20 条回复的 bigram 相似度 > 0.8
 * post：非空 / 加权重 ≤ 280 / 纯表情
 */
export function contentProblem(action, text, cfg) {
  const body = String(text ?? '').trim()
  if (!body) return '正文是空的'
  if (isPureEmoji(body)) return '正文只有表情/符号，没有任何文字'
  const chars = Array.from(body).length
  if (action === 'reply') {
    if (chars < cfg.replyMinChars) return '回复太短（' + chars + ' 字，下限 ' + cfg.replyMinChars + ' 字）：这种话等于没回'
    const head = stripLeadingNoise(body)
    const hit = BAN_PREFIX.find((w) => {
      if (Array.from(w).length === 1) return Array.from(head).length <= 8 && head.startsWith(w)
      return head.startsWith(w)
    })
    if (hit) return '开头是八股套话「' + hit + '…」（说得好 / 学习了 / 支持 之类一律不发）'
    if (!cfg.replyAllowLinks && HAS_LINK_RE.test(body)) return '回复里带链接，而 replyAllowLinks 是关的（冷启动期不放链接）'
    const mine = bigrams(Array.from(body).slice(0, 40).join(''))
    let worst = 0
    let worstText = ''
    for (const prev of recentReplyTexts(20)) {
      const sim = dice(mine, bigrams(prev))
      if (sim > worst) { worst = sim; worstText = prev }
    }
    if (worst > 0.8) return '和你最近回过的一条太像（bigram ' + worst.toFixed(2) + ' > 0.8）：「' + worstText.slice(0, 40) + '」'
    if (weightedLength(body) > 280) return '回复超过 280 加权字符（' + weightedLength(body) + '/' + 280 + '）'
    return null
  }
  // post（含引用转推）
  const w = weightedLength(body)
  const lim = asInt(cfg && cfg.maxPostWeight, 25000, 1, 25000)
  if (w > lim) return '超过 ' + lim + ' 加权字符（' + w + '/' + lim + '，URL 算 23、中文算 2；长文请把 maxPostWeight 调高）'
  return null
}

/* ────────────────────────────── ⑥ 去重 ────────────────────────────── */

/** 返回拒绝原因字符串，或 null */
export function dedupeProblem(action, params) {
  const seen = readSeen()
  const p = params || {}
  if (action === 'like') {
    const id = String(p.target || '')
    if (id && seen.liked[id]) return '这条已经赞过了（' + seen.liked[id] + '）'
    return null
  }
  if (action === 'follow') {
    const h = String(p.target || '').toLowerCase()
    if (h && seen.followed[h]) return '已经关注过 @' + h + ' 了（' + seen.followed[h] + '）'
    return null
  }
  if (action === 'reply') {
    const id = String(p.target || '')
    if (id && seen.replied[id]) return '这条已经回过了（' + seen.replied[id] + '），同一目标只回一次'
    return null
  }
  // post：没有目标 id，按"今天发过的开头 40 字"去重，防重复发
  if (action === 'post') {
    const body = excerpt(p.text, 40)
    if (!body) return null
    const today = dayKey(new Date())
    for (const e of readLedger()) {
      if (!e || e.ok !== true || e.action !== 'post') continue
      let k = ''
      try { k = dayKey(e.ts) } catch { continue }
      if (k !== today) continue
      if (String(e.note || '') === body) return '今天已经发过开头一模一样的帖了（「' + body + '」）'
    }
    return null
  }
  return null
}

/* ────────────────────────────── ⑦ 总闸编排 ────────────────────────────── */

const BLOCK = (blocked, reason) => ({ ok: false, blocked, reason })

/**
 * 跑一遍 ①→⑧。execute() 只有全部闸门放行后才会被调用（且只调用一次）。
 *
 * @param {string} action like | follow | reply | post
 * @param {object} params {target, text, confirm}
 * @param {Function} execute async () => result
 * @returns {{ok:true, result, entry, today}} | {{ok:false, blocked, reason, code?}}
 */
export async function runGated(action, params, execute) {
  const cfg = readWriteConfig()
  const p = params || {}
  const label = ACTION_LABELS[action] || action
  const target = cleanTarget(action, p.target)
  const text = String(p.text ?? '')

  // ① 总闸（fail-closed：默认 false，读不到配置也是 false）
  if (!cfg.allowWrite) {
    return { ok: false, blocked: 'allowWrite', reason: '总闸 allowWrite 是关的：点赞/关注/回复/发帖一律不执行（设置页打开总闸，或 config.json 里改 allowWrite）' }
  }
  // ② 单项开关
  const sw = SWITCH_FIELDS[action]
  if (!sw || !cfg[sw]) {
    return { ok: false, blocked: sw || 'allow', reason: label + '的开关 ' + (sw || '') + ' 是关的' }
  }
  // ③ confirm（reply / post 默认要求）
  const needConfirm = (action === 'reply' && cfg.replyRequireConfirm) || (action === 'post' && cfg.postRequireConfirm)
  if (needConfirm && asBool(p.confirm, false) !== true) {
    return { ok: false, blocked: 'confirm', reason: label + '要求显式 confirm:true 才会执行（防模型顺手发出去）' }
  }
  // ④ 当日额度
  const counts = todayCounts(new Date())
  const max = cfg[LIMIT_FIELDS[action]]
  const used = counts[action] || 0
  if (!Number.isFinite(max) || max <= 0) {
    return { ok: false, blocked: 'quota', reason: label + '额度是 0（' + LIMIT_FIELDS[action] + '=0）：今天不许' + label }
  }
  if (used >= max) {
    return { ok: false, blocked: 'quota', reason: label + '额度用尽：今天已用 ' + used + '/' + max + '（' + LIMIT_FIELDS[action] + '）' }
  }
  // ⑤ 去重
  const dup = dedupeProblem(action, { target, text })
  if (dup) {
    recordBlocked(action, target, 'dedupe', dup)
    return BLOCK('dedupe', dup)
  }
  // ⑥ 内容闸门（reply / post）
  if (action === 'reply' || action === 'post') {
    const bad = contentProblem(action, text, cfg)
    if (bad) {
      recordBlocked(action, target, 'content', bad)
      return BLOCK('content', bad)
    }
  }

  // ⑦ 执行
  let result
  try {
    result = await execute({ cfg, target, text })
  } catch (e) {
    const reason = redact((e && e.message) || '执行失败')
    const code = (e && e.code) || 'execute_failed'
    appendLedger({ action, target, ok: false, tweetId: '', blocked: 'execute', note: '执行失败：' + code + ' ' + excerpt(reason, 80) })
    return { ok: false, blocked: 'execute', reason, code }
  }

  // ⑧ 记账 + 去重表
  const tweetId = tweetIdOf(action, result)
  const entry = {
    action,
    target,
    ok: true,
    tweetId,
    blocked: '',
    note: action === 'reply' || action === 'post' ? excerpt(text, 40) : '',
  }
  appendLedger(entry)
  if (action === 'like') markSeen('like', target)
  else if (action === 'follow') markSeen('follow', target.toLowerCase())
  else if (action === 'reply') markSeen('reply', target)
  else if (action === 'post') markSeen('post', tweetId || excerpt(text, 20))
  log('写操作成功：' + action + ' ' + target + (tweetId ? ' → ' + tweetId : ''))
  return { ok: true, result, entry, today: todayCounts(new Date()) }
}

function cleanTarget(action, raw) {
  const s = String(raw ?? '').trim()
  if (action === 'follow') return s.replace(/^@/, '')
  return s
}

function tweetIdOf(action, result) {
  const d = result && typeof result === 'object' ? (result.data && typeof result.data === 'object' ? result.data : result) : {}
  if (action === 'follow') return String(d.userId || '')
  if (action === 'like') return String(d.id || '')
  return String(d.id || '')
}

/** 被闸住的尝试也留痕（总闸关除外：那是最常见的常态，不写盘免得刷噪音） */
function recordBlocked(action, target, blocked, reason) {
  appendLedger({ action, target, ok: false, tweetId: '', blocked, note: excerpt(reason, 80) })
}

/* ────────────────────────────── ⑧ 状态汇总（给 x_write_status / x_status） ────────────────────────────── */

export function writeSummary() {
  const cfg = readWriteConfig()
  const today = todayCounts(new Date())
  const ledger = readLedger()
  return {
    ok: true,
    allowWrite: cfg.allowWrite,
    allowLike: cfg.allowLike,
    allowFollow: cfg.allowFollow,
    allowReply: cfg.allowReply,
    allowPost: cfg.allowPost,
    require: { replyConfirm: cfg.replyRequireConfirm, postConfirm: cfg.postRequireConfirm },
    limits: {
      like: cfg.maxLikesPerDay,
      follow: cfg.maxFollowsPerDay,
      reply: cfg.maxRepliesPerDay,
      post: cfg.maxPostsPerDay,
    },
    today,
    content: { replyMinChars: cfg.replyMinChars, replyAllowLinks: cfg.replyAllowLinks },
    recent: ledger.slice(-5),
    ledgerPath: writePaths().ledger,
    configPath: writePaths().config,
    configOk: cfg.configOk,
  }
}
