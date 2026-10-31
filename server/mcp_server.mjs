#!/usr/bin/env node
/**
 * server/mcp_server.mjs —— 「刷 X」的 MCP 服务器（stdio，逐行 JSON-RPC）
 * ============================================================================
 * 干什么：把这边的 x_* 工具转成 twitter-cli 的**只读**子命令，结构化吐回去。
 * 数据从哪来：twitter-cli 0.8.5（status / whoami / search / user / user-posts / tweet / followers）。
 * 真实取值全部在 ../lib/xcli.mjs：找二进制、注入凭据、探测代理、解析 --json。
 * 这个文件**只管协议和契约字段**，不重复实现那些事。
 *
 * 协议层照抄上一代插件（initialize / notifications/initialized / notifications/cancelled /
 * ping / tools/list / tools/call），不自己发明：stdio 上**一行一个 JSON-RPC**，
 * 一行一条，能并发收，但工具调用串行执行（twitter-cli 有速率限制，且避免同时挤爆代理）。
 *
 * 🔴 硬约束：
 *   1. **只读**：不实现 post / reply / like / retweet / follow，连想都别想。
 *   2. 坏通道**不抛异常**：代理不通 / 凭据缺失 / 找不到 CLI，都返回 {ok:false,error}，
 *      让 host 去写"失败日报"，而不是把整个宿主带崩。
 *   3. 凭据只注入子进程 env，日志只写"有/无"和来源。
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
  log,
  redact,
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
  if (problems.length) payload.error = problems.join('；')
  return payload
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
