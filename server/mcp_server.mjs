#!/usr/bin/env node
/**
 * server/mcp_server.mjs —— 「刷 X」的 MCP 服务器（stdio，逐行 JSON-RPC）
 * ============================================================================
 * 干什么：把这边的 x_* 工具转成 twitter-cli 子命令，结构化吐回去。
 * 数据从哪来：twitter-cli 0.8.5（status / whoami / search / user / user-posts / tweet / followers / like / follow / reply / post / quote）。
 * 真实取值全部在 ../lib/xcli.mjs：找二进制、注入凭据、探测代理、解析 --json。
 * 这个文件**只管协议和契约字段**，不重复实现那些事。
 *
 * 写操作（CONTRACT v0.2）：x_like / x_follow / x_reply / x_post 四个写工具，
 * 以及 x_write_status。**开关默认全关**；每个写工具都先过 ../lib/writegate.mjs 的七道闸门
 * （总闸 → 单项开关 → confirm → 当日额度 → 去重 → 内容闸门 → 执行 → 台账），
 * 任何一条不过就返回 {ok:false, blocked:'<闸门名>', reason}，绝不落笔。
 *
 * 协议层照抄上一代插件（initialize / notifications/initialized / notifications/cancelled /
 * ping / tools/list / tools/call），不自己发明：stdio 上**一行一个 JSON-RPC**，
 * 一行一条，能并发收，但工具调用串行执行（twitter-cli 有速率限制，且避免同时挤爆代理）。
 *
 * 🔴 硬约束：
 *   1. **写操作默认全关**：总闸 allowWrite=false 时四个写工具一律 blocked，连 CLI 都不启动。
 *      开关只解决"能不能"，额度解决"多少"，台账解决"可追"；不做任何自动绕过。
 *   2. 坏通道**不抛异常**：代理不通 / 凭据缺失 / 找不到 CLI，都返回 {ok:false,error}，
 *      让 host 去写"失败日报"，而不是把整个宿主带崩。
 *   3. 凭据只注入子进程 env，日志只写"有/无"和来源；台账不写凭据、不写正文全文。
 *
 * 环境变量：
 *   X_DUTY_HOME  插件家目录（日志落这）
 *   X_TWITTER_BIN  twitter-cli 可执行文件（不设就自动找）
 *   X_PROXY       代理（不设就自动探 7890 → 7892 → 系统代理）
 *   X_TOOLS       工具白名单（逗号分隔；不设 = 全放）
 * ============================================================================
 */
import {
  VERSION,
  blueRatioOf,
  enrichAuthors,
  followUser,
  likeTweet,
  log,
  postTweet,
  quoteTweet,
  redact,
  replyTweet,
  resolveBin,
  resolveCredentials,
  resolveProxy,
  runTw,
  search,
  toReply,
  tweetDetail,
  userPosts,
  userProfile,
  whoami,
  xHome,
} from '../lib/xcli.mjs'
import { runGated, writeSummary } from '../lib/writegate.mjs'
import { createArticleDraft, publishArticle } from '../lib/article.mjs'

const HOME = xHome()

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const int = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : 0
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const errText = (e) => redact(clean((e && e.message) || e) || '未知错误')

/** x_search 的 sort 只认这三个，其它一律按 general（CLI 那边映射成 -t Top） */
function normSort(sort) {
  const s = clean(sort).toLowerCase()
  if (s === 'latest' || s === '最新') return 'latest'
  if (s === 'popular' || s === '最热') return 'popular'
  return 'general'
}

/** 从推文链接里抠 id（https://x.com/<handle>/status/<id>） */
function idFromUrl(url) {
  const m = String(url ?? '').match(/(?:status|statuses)\/(\d{5,25})/)
  return m ? m[1] : ''
}

/* ────────────────────────────── 工具实现 ────────────────────────────── */

/**
 * 通道体检：二进制 / 代理 / 凭据 / 账号四件事一次说清。
 * 契约：{ok, proxy:{url,source}, cred:{ok}, cli:{bin,version}, account:{needLogin}}
 * 坏代理时 ok=false 且**不崩** —— 这是宿主决定"能不能起跑"的唯一依据。
 */
async function toolStatus() {
  const bin = await resolveBin()
  const proxy = await resolveProxy()
  const cred = await resolveCredentials()

  let authenticated = false
  let handle = ''
  let statusError = ''
  if (bin.ok && proxy.ok) {
    const r = await runTw(['status'], { proxyInfo: proxy, credInfo: cred, timeoutMs: 45000 })
    if (r.ok) {
      const u = (r.data && r.data.user) || {}
      authenticated = Boolean(r.data && r.data.authenticated)
      handle = clean(u.screenName || u.username)
    } else {
      statusError = (r.error && r.error.message) || 'status 调用失败'
    }
  }

  const problems = []
  if (!bin.ok) problems.push(bin.error)
  if (!proxy.ok && proxy.error) problems.push(proxy.error.message)
  if (!cred.ok && cred.error) problems.push(cred.error)
  if (statusError) problems.push(statusError)
  if (bin.ok && proxy.ok && cred.ok && !authenticated && !statusError) problems.push('账号没登进去（needLogin）')

  const payload = {
    ok: Boolean(bin.ok && proxy.ok && authenticated),
    proxy: { url: (proxy.report && proxy.report.url) || '', source: (proxy.report && proxy.report.source) || 'none' },
    cred: { ok: Boolean(cred.ok), source: cred.source || '' },
    cli: { bin: bin.bin || '', version: bin.version || '', source: bin.source || '' },
    account: { needLogin: !authenticated, authenticated, handle },
  }
  if (payload.proxy.source !== 'direct' && proxy.candidates && proxy.candidates.length) {
    payload.proxy.candidates = proxy.candidates
  }
  // CONTRACT v0.2 §4：日报要能看到"今天能不能动手、动了几次"
  payload.write = writeSummaryBlock()
  if (problems.length) payload.error = problems.join('；')
  return payload
}

/**
 * 写开关 + 今日用量（x_status 用）。
 * 只挑 x_status 契约里要的字段，不把最近台账整段塞进去（那是 x_write_status 的事）。
 * 读不到 config.json ⇒ 全部 false（fail-closed）。
 */
function writeSummaryBlock() {
  try {
    const s = writeSummary()
    return {
      allowWrite: s.allowWrite,
      allowLike: s.allowLike,
      allowFollow: s.allowFollow,
      allowReply: s.allowReply,
      allowPost: s.allowPost,
      today: s.today,
      limits: s.limits,
    }
  } catch (e) {
    log('读写开关失败（按全关处理）：' + errText(e))
    return { allowWrite: false, allowLike: false, allowFollow: false, allowReply: false, allowPost: false, today: { date: '', like: 0, follow: 0, reply: 0, post: 0 }, limits: {} }
  }
}

/** 当前账号：契约 {ok, handle, name, followers, following, tweets, verified, createdAt} */
async function toolWhoami() {
  try {
    const u = await whoami()
    return {
      ok: true,
      handle: u.handle,
      name: u.name,
      followers: u.followers,
      following: u.following,
      tweets: u.tweets,
      verified: u.verified,
      createdAt: u.createdAt,
    }
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

/** 搜推文：契约 {ok, query, count, posts[], error?} */
async function toolSearch(args) {
  const a = args || {}
  const query = clean(a.query)
  if (!query) return { ok: false, query: '', count: 0, posts: [], error: 'query 不能为空（关键词，不是一整句话）' }
  const limit = clamp(int(a.limit) || 20, 1, 50)
  const sort = normSort(a.sort)
  try {
    const posts = await enrichAuthors(await search({ query, limit, sort }))
    log('x_search「' + query + '」→ ' + posts.length + ' 条（sort=' + sort + '）')
    return { ok: true, query, count: posts.length, posts }
  } catch (e) {
    return { ok: false, query, count: 0, posts: [], error: errText(e) }
  }
}

/** 看某个号：契约 {ok, handle, name, bio, followers, following, tweets, verified, createdAt, url} */
async function toolUser(args) {
  const a = args || {}
  const handle = clean(a.handle).replace(/^@/, '')
  if (!handle) return { ok: false, error: 'handle 不能为空' }
  try {
    const u = await userProfile(handle)
    return {
      ok: true,
      handle: u.handle,
      name: u.name,
      bio: u.bio,
      followers: u.followers,
      following: u.following,
      tweets: u.tweets,
      verified: u.verified,
      createdAt: u.createdAt,
      url: u.url,
    }
  } catch (e) {
    return { ok: false, handle, error: errText(e) }
  }
}

/** 某个号最近发了什么：契约 {ok, handle, count, posts[]} */
async function toolPosts(args) {
  const a = args || {}
  const handle = clean(a.handle).replace(/^@/, '')
  if (!handle) return { ok: false, handle: '', count: 0, posts: [], error: 'handle 不能为空' }
  const limit = clamp(int(a.limit) || 20, 1, 100)
  try {
    const posts = await enrichAuthors(await userPosts({ handle, limit }))
    return { ok: true, handle, count: posts.length, posts }
  } catch (e) {
    return { ok: false, handle, count: 0, posts: [], error: errText(e) }
  }
}

/** 精读一条推文（带回复区）：契约 {ok, id, url, text, author, metrics, createdAt, replies[]} */
async function toolTweet(args) {
  const a = args || {}
  const rawId = clean(a.id)
  const rawUrl = clean(a.url)
  const id = rawId || idFromUrl(rawUrl)
  if (!id) {
    return { ok: false, id: '', url: '', error: '需要推文 id 或完整链接（https://x.com/<handle>/status/<id>）' }
  }
  try {
    const det = await tweetDetail({ idOrUrl: rawUrl || id, replies: 20 })
    if (!det) return { ok: false, id, url: rawUrl, error: '没读到这条推文（可能已删 / 受保护 / id 不对）' }
    const t = det.tweet || {}
    const handle = clean(t.author && t.author.screenName)
    return {
      ok: true,
      id: clean(t.id) || id,
      url: 'https://x.com/' + (handle || 'i') + '/status/' + (clean(t.id) || id),
      text: String(t.text ?? ''),
      author: handle,
      metrics: t.metrics || {},
      createdAt: clean(t.createdAtISO || t.createdAt),
      replies: (det.replies || []).map(toReply),
    }
  } catch (e) {
    return { ok: false, id, url: rawUrl, error: errText(e) }
  }
}

/**
 * 涨粉与曝光：契约 {ok, handle, followers, following, tweets, verified, blueRatio?, recent:{avgViews,maxViews,posts}}
 * 现算 —— whoami 拿粉丝/关注，user-posts 拿最近 N 条的 metrics 算平均/最高曝光。
 * blueRatio 是**抽样**关注者里带蓝标的比例，只在抽样成功时给，且必须注明非官方口径。
 */
async function toolGrowth() {
  try {
    const me = await whoami()
    const posts = await userPosts({ handle: me.handle, limit: 10 })
    const views = posts.map((p) => int(p.views))
    const sum = views.reduce((a, b) => a + b, 0)
    const out = {
      ok: true,
      handle: me.handle,
      followers: me.followers,
      following: me.following,
      tweets: me.tweets,
      verified: me.verified,
      recent: {
        avgViews: views.length ? Math.round(sum / views.length) : 0,
        maxViews: views.length ? Math.max.apply(null, views) : 0,
        posts: posts.length,
      },
    }
    const blue = await blueRatioOf(me.handle)
    if (blue) {
      out.blueRatio = blue.ratio
      out.blueSample = blue.sample
      out.blueNote = blue.note
    }
    return out
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
}

/* ────────────────────────────── 写工具（CONTRACT v0.2） ────────────────────────────── */

/**
 * 输入形状检查：在七道闸门之前先挡掉"明显没法执行"的入参。
 * 它不是闸门之一（闸门见 lib/writegate.mjs），所以 blocked 记 'input'，方便和七道闸门区分。
 */
function inputBlock(reason, extra) {
  return Object.assign({ ok: false, blocked: 'input', reason }, extra || {})
}

/** 闸门拒绝 / 执行失败的统一返回：blocked 指明是哪一条 */
function gateFail(action, target, r) {
  const out = { ok: false, blocked: r.blocked || 'unknown', reason: r.reason || '被闸门拦下', action }
  if (target) out.target = target
  if (r.code) out.code = r.code
  if (r.blocked === 'execute' && r.code === 'rate_limited') {
    out.hint = '碰到 429 限流：停手，等 30-60 秒再说一次，别连续重试'
  }
  return out
}

function writeData(result) {
  if (!result || typeof result !== 'object') return {}
  return result.data && typeof result.data === 'object' ? result.data : result
}

/** 点赞：{id, confirm?} —— 已赞过由去重闸门拦，不重复点 */
async function toolLike(args) {
  const a = args || {}
  const id = clean(a.id).replace(/^#/, '')
  if (!/^\d{5,25}$/.test(id)) return inputBlock('id 必须是纯数字推文 id（5-25 位）', { action: 'like', id })
  const r = await runGated('like', { target: id, confirm: a.confirm }, () => likeTweet(id))
  if (!r.ok) return gateFail('like', id, r)
  const d = writeData(r.result)
  return {
    ok: true,
    action: 'like',
    id,
    tweetId: String(d.id || id),
    url: 'https://x.com/i/status/' + id,
    today: r.today,
    ledger: r.entry,
    note: '已点赞，并记进台账（同一条不会点第二次）',
  }
}

/** 关注：{handle, confirm?} —— 已关注由去重闸门拦 */
async function toolFollow(args) {
  const a = args || {}
  const handle = clean(a.handle).replace(/^@/, '')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return inputBlock('handle 不合法：X 用户名只能是字母 / 数字 / 下划线，≤15 位（不带 @）', { action: 'follow', handle })
  }
  const r = await runGated('follow', { target: handle, confirm: a.confirm }, () => followUser(handle))
  if (!r.ok) return gateFail('follow', handle, r)
  const d = writeData(r.result)
  return {
    ok: true,
    action: 'follow',
    handle,
    userId: String(d.userId || ''),
    url: 'https://x.com/' + handle,
    today: r.today,
    ledger: r.entry,
    note: '已关注，并记进台账（同一个人不会关注第二次）',
  }
}

/** 回复：{id, text, confirm?} —— 语感 / 长度 / 链接 / bigram 四道都在内容闸门里 */
async function toolReply(args) {
  const a = args || {}
  const id = clean(a.id).replace(/^#/, '') || idFromUrl(a.url)
  if (!id) return inputBlock('需要推文 id 或完整链接（https://x.com/<handle>/status/<id>）', { action: 'reply' })
  if (!/^\d{5,25}$/.test(id)) return inputBlock('推文 id 不合法（应该是 5-25 位数字）', { action: 'reply', id })
  const text = String(a.text ?? '')
  if (!text.trim()) return inputBlock('回复正文是空的', { action: 'reply', id })
  const r = await runGated('reply', { target: id, text, confirm: a.confirm }, () => replyTweet(id, text))
  if (!r.ok) return gateFail('reply', id, r)
  const d = writeData(r.result)
  const newId = String(d.id || '')
  return {
    ok: true,
    action: 'reply',
    id: newId,
    replyTo: id,
    url: String(d.url || ('https://x.com/i/status/' + newId)),
    today: r.today,
    ledger: r.entry,
    note: '回复已发出，并记进台账（正文只存前 40 字）',
  }
}

/** 发帖：{text, confirm?, replyTo?} —— 带 replyTo 就是引用转推（CLI 的 quote） */
async function toolPost(args) {
  const a = args || {}
  const text = String(a.text ?? '')
  if (!text.trim()) return inputBlock('正文是空的', { action: 'post' })
  const replyTo = clean(a.replyTo || a.quoteId || '').replace(/^#/, '')
  if (replyTo && !/^\d{5,25}$/.test(replyTo)) {
    return inputBlock('replyTo（要引用的推文 id）不合法：应该是 5-25 位数字', { action: 'post', replyTo })
  }
  const r = await runGated('post', { target: replyTo, text, confirm: a.confirm }, () => (
    replyTo ? quoteTweet(replyTo, text) : postTweet(text)
  ))
  if (!r.ok) return gateFail('post', replyTo, r)
  const d = writeData(r.result)
  const newId = String(d.id || '')
  const out = {
    ok: true,
    action: replyTo ? 'quote' : 'post',
    id: newId,
    url: String(d.url || ('https://x.com/i/status/' + newId)),
    today: r.today,
    ledger: r.entry,
    note: '已发布，并记进台账（正文只存前 40 字）',
  }
  if (replyTo) out.quotedId = replyTo
  return out
}

/** 文章：{title?, markdown, publish?, confirm?} —— 建草稿，publish!==false 时立刻发布 */
async function toolArticle(args) {
  const a = args || {}
  const markdown = String(a.markdown ?? a.text ?? '')
  const title = String(a.title ?? '')
  if (!markdown.trim()) return inputBlock('正文（markdown）是空的', { action: 'article' })
  const wantPublish = a.publish !== false
  const r = await runGated('article', { target: '', text: title || markdown.split('\n')[0], confirm: a.confirm }, async () => {
    const cred = await resolveCredentials({})
    if (!cred.ok) throw Object.assign(new Error(cred.error || '缺凭据'), { code: 'no_credential' })
    const px = await resolveProxy({})
    const opts = { token: cred.token, ct0: cred.ct0, proxyUrl: px && px.ok ? px.url : '' }
    const draft = await createArticleDraft({ title, markdown, opts })
    if (!wantPublish) return { data: { id: draft.id, draft: true, title: draft.title } }
    const pub = await publishArticle(draft.id, opts)
    return { data: { id: draft.id, url: 'https://x.com/i/articles/' + draft.id, draft: false, title: draft.title, published: !!pub } }
  })
  if (!r.ok) return gateFail('article', '', r)
  const d = writeData(r.result)
  return {
    ok: true,
    action: 'article',
    id: String(d.id || ''),
    url: String(d.url || ('https://x.com/i/articles/' + String(d.id || ''))),
    draft: !!d.draft,
    title: String(d.title || ''),
    today: r.today,
    ledger: r.entry,
    note: d.draft ? '草稿已建（未发布）' : '文章已发布',
  }
}

/** 写开关与今日用量：四个开关 + 今日已用/上限 + 台账最后 5 条 */
function toolWriteStatus() {
  return writeSummary()
}

/* ────────────────────────────── 工具清单（名字/参数 = CONTRACT 第 1 节） ────────────────────────────── */

const TOOLS = [
  {
    name: 'x_status',
    description: '看 X 这边的通道状态：twitter-cli 在不在、代理通不通、凭据有没有、账号要不要登录。'
      + '第一次用、或者"连不上/报错了"先看这个。',
    inputSchema: { type: 'object', properties: {} },
    run: () => toolStatus(),
  },
  {
    name: 'x_whoami',
    description: '当前登录账号的档案（handle / 昵称 / 粉丝 / 关注 / 推文数 / 蓝标）。',
    inputSchema: { type: 'object', properties: {} },
    run: () => toolWhoami(),
  },
  {
    name: 'x_search',
    description: '按关键词搜 X 上的推文，返回 id / 链接 / 作者 / 作者粉丝数 / 蓝标 / 正文 / 赞·回·转 / 时间。'
      + '刷一轮的用法：每个方向搜一次（20 条左右），再挑值得的用 x_tweet 读正文和回复区。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（一个方向一个词/短语，别写一整句话）' },
        limit: { type: 'number', description: '返回几条（默认 20，最大 50）' },
        sort: { type: 'string', description: 'general 综合 / latest 最新 / popular 最热' },
      },
      required: ['query'],
    },
    run: (a) => toolSearch(a),
  },
  {
    name: 'x_user',
    description: '看一个账号的档案：昵称 / bio / 粉丝 / 关注 / 推文数 / 蓝标 / 注册时间 / 主页链接。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '账号名（不带 @，例如 jack）' },
      },
      required: ['handle'],
    },
    run: (a) => toolUser(a),
  },
  {
    name: 'x_posts',
    description: '列某个账号最近的推文（含曝光 views，能看出他哪条真的跑起来了）。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '账号名（不带 @）' },
        limit: { type: 'number', description: '取几条（默认 20，最大 100）' },
      },
      required: ['handle'],
    },
    run: (a) => toolPosts(a),
  },
  {
    name: 'x_tweet',
    description: '读一条推文的正文 + 指标 + 回复区。判断一条帖值不值得回，靠这个看评论区竞争度。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '推文 id（数字串）' },
        url: { type: 'string', description: '或者给完整链接（x.com/…/status/<id>）' },
      },
    },
    run: (a) => toolTweet(a),
  },
  {
    name: 'x_growth',
    description: '账号涨粉与曝光现算：粉丝 / 关注 / 推文数 / 蓝标 / 近 10 条平均与最高曝光 / 关注者蓝标比例（抽样）。',
    inputSchema: { type: 'object', properties: {} },
    run: () => toolGrowth(),
  },
  {
    name: 'x_like',
    description: '给一条推文点赞。⚠️ 写操作：要求 config 里 allowWrite + allowLike 都打开，且今天没超 maxLikesPerDay；'
      + '同一条不会点第二次（台账去重）。被闸住时返回 {ok:false, blocked, reason}。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '推文 id（数字串）' },
        confirm: { type: 'boolean', description: '点赞不要求 confirm（只有回复/发帖默认要求）' },
      },
      required: ['id'],
    },
    run: (a) => toolLike(a),
  },
  {
    name: 'x_follow',
    description: '关注一个账号。⚠️ 写操作：要求 allowWrite + allowFollow，且今天没超 maxFollowsPerDay；'
      + '已关注过的人会被去重闸门拦下。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: '账号名（不带 @）' },
        confirm: { type: 'boolean', description: '关注不要求 confirm' },
      },
      required: ['handle'],
    },
    run: (a) => toolFollow(a),
  },
  {
    name: 'x_reply',
    description: '回复一条推文。⚠️ 写操作：要求 allowWrite + allowReply（默认还要求 confirm:true）、当日额度未满；'
      + '正文要过内容闸门：开头八股（说得好/学习了/支持…）、纯表情、太短、带链接（replyAllowLinks 关时）、'
      + '和自己最近 20 条回复太像（bigram>0.8）都会被拒。同一条只回一次。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要回复的推文 id' },
        text: { type: 'string', description: '回复正文（必须带具体信息：数字 / 反例 / 可执行动作）' },
        confirm: { type: 'boolean', description: 'replyRequireConfirm=true 时必须显式 true' },
      },
      required: ['id', 'text'],
    },
    run: (a) => toolReply(a),
  },
  {
    name: 'x_post',
    description: '发一条推文（带 replyTo 就是引用转推）。⚠️ 写操作：要求 allowWrite + allowPost（默认还要求 confirm:true）；'
      + '正文 ≤280 加权字符（URL 算 23、中文算 2）。返回 tweet id / url。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '正文（≤280 加权字符）' },
        confirm: { type: 'boolean', description: 'postRequireConfirm=true 时必须显式 true' },
        replyTo: { type: 'string', description: '要引用的推文 id（给了就走引用转推）' },
      },
      required: ['text'],
    },
    run: (a) => toolPost(a),
  },
  {
    name: 'x_article',
    description: '发一篇 X 文章（Article，独立页面）：标题 + markdown 正文，默认建草稿后立刻发布。'
      + '⚠️ 写操作：要求 allowWrite + allowPost，默认要求 confirm:true；计入 maxPostsPerDay。'
      + 'publish=false 只建草稿。返回文章 id / url。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '标题（也可用 markdown 第一行 # 标题）' },
        markdown: { type: 'string', description: '正文 markdown（支持 # 标题、- 列表、> 引用、--- 分隔线）' },
        publish: { type: 'boolean', description: '默认 true；false 只建草稿' },
        confirm: { type: 'boolean', description: 'postRequireConfirm=true 时必须显式 true' },
      },
      required: ['markdown'],
    },
    run: (a) => toolArticle(a),
  },
  {
    name: 'x_write_status',
    description: '写开关与今日用量：四个开关 + 今日已用/上限 + 台账最后 5 条（不含正文全文）。'
      + '动手之前先看这个，别硬试。',
    inputSchema: { type: 'object', properties: {} },
    run: () => toolWriteStatus(),
  },
]

const WHITELIST = (() => {
  const raw = String(process.env.X_TOOLS || '').trim()
  if (!raw) return null
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
})()

const usable = () => TOOLS.filter((t) => !WHITELIST || WHITELIST.has(t.name))

/* 一次只跑一个工具（twitter-cli 有速率限制；并发也会让同一条代理更挤） */
let chain = Promise.resolve()
const serialize = (fn) => {
  const run = chain.then(fn, fn)
  chain = run.catch(() => { /* 别让链子断掉 */ })
  return run
}

/* ────────────────────────────── MCP 协议（照抄 baseline） ────────────────────────────── */

function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n') } catch { /* stdout 断了 */ }
}

async function onMessage(msg) {
  const { id, method, params } = msg || {}
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'x-duty', version: VERSION },
      },
    })
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: usable().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
  }
  if (method === 'tools/call') {
    const tool = usable().find((t) => t.name === params?.name)
    if (!tool) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '没有这个工具：' + params?.name }] } })
    try {
      const value = await serialize(() => tool.run(params?.arguments || {}))
      log('工具 ' + tool.name + ' 完成（ok=' + Boolean(value && value.ok) + '）')
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } })
    } catch (e) {
      log('工具 ' + tool.name + ' 出错：' + errText(e))
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '出错了：' + errText(e) }] } })
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: '不支持的方法：' + method } })
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    onMessage(msg).catch((e) => log('处理消息出错：' + errText(e)))
  }
})
/**
 * 收完 stdin 不能立刻 exit：一次喂多行时，tools/call 还在跑。
 * 等串行链跑干净再退（stdout 是异步写，多留 100ms 让它写完）。
 */
const drainAndExit = () => {
  Promise.resolve(chain)
    .catch(() => { /* 链子里的错误已经各自处理过 */ })
    .then(() => setTimeout(() => process.exit(0), 100))
}
process.stdin.on('end', drainAndExit)
process.on('SIGTERM', drainAndExit)
process.on('uncaughtException', (e) => log('未捕获异常：' + errText(e)))
process.on('unhandledRejection', (e) => log('未处理的 rejection：' + errText(e)))

log('刷 X MCP 起来了（v' + VERSION + '，家=' + HOME + '，可见工具=' + usable().map((t) => t.name).join(',') + '）')
