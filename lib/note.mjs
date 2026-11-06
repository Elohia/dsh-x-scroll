/**
 * lib/note.mjs —— 长帖（>280 加权字符）发布：X 的 CreateNoteTweet 通道
 * ============================================================================
 * 背景（2026-11-06 实测）：
 *   twitter-cli 0.8.5 只走 CreateTweet（Uf3io9zVp1DsYxrmL5FJ7g），服务端对任何账号都按 280 截；
 *   连 300 个英文字符都回 "Tweet needs to be a bit shorter (186)"。
 *   X 网页端发长帖用的是另一个 GraphQL 操作 CreateNoteTweet（_eeuQKX1-VyRP_ROM-GN7g），
 *   变量 { tweet_text, media, semantic_annotation_ids, disallowed_reply_options }，
 *   返回 data.notetweet_create.tweet_results.result.rest_id。
 *   实测：545 字 / 300 字长帖都能发出去，随后删除也正常。
 *
 * 本文件只做一件事：拿 cookie 凭据，走代理，POST 这个操作。
 * 不进模型上下文：正文由调用方给，凭据只从环境/注册表读、只写进请求头，不打印不落盘。
 * ============================================================================
 */
import net from 'node:net'
import tls from 'node:tls'
import { URL } from 'node:url'

/** X 网页端公开 bearer（与 twitter-cli 的 constants.BEARER_TOKEN 同一串，不是用户凭据） */
const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const HOST = 'x.com'
const QID = '_eeuQKX1-VyRP_ROM-GN7g'
const OP = 'CreateNoteTweet'

/** CreateNoteTweet 需要的 feature 集合（照 X 网页端；缺 longform 那几个会被当普通帖截断） */
const FEATURES = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  longform_notetweets_creation_enabled: true,
  rweb_video_timestamps_enabled: true,
  responsive_web_media_download_video_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  responsive_web_enhance_cards_enabled: false,
}

function openSocket(proxyUrl, host, port, timeoutMs) {
  const timeout = timeoutMs || 20000
  return new Promise((resolve, reject) => {
    if (!proxyUrl || /^direct$/i.test(String(proxyUrl))) {
      const s = tls.connect({ host, port, servername: host }, () => resolve(s))
      s.once('error', reject)
      s.setTimeout(timeout, () => s.destroy(new Error('TLS 连接超时')))
      return
    }
    const p = new URL(proxyUrl)
    const sock = net.connect({ host: p.hostname, port: Number(p.port || 80) })
    sock.setTimeout(timeout, () => sock.destroy(new Error('代理连接超时')))
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

function httpPostJson(socket, path, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const lines = ['POST ' + path + ' HTTP/1.1', 'Host: ' + HOST, 'Content-Type: application/json',
      'Content-Length: ' + body.length, 'Connection: close']
    for (const [k, v] of Object.entries(headers)) lines.push(k + ': ' + v)

    let head = ''
    let restBuf = Buffer.alloc(0)
    let headersDone = false
    let done = false

    const decodeChunked = () => {
      const out = []
      let i = 0
      for (;;) {
        const eol = restBuf.indexOf('\r\n', i)
        if (eol < 0) return null
        const size = parseInt(restBuf.subarray(i, eol).toString('latin1'), 16)
        if (!Number.isFinite(size)) return null
        if (size === 0) return Buffer.concat(out).toString('utf8')
        if (restBuf.length < eol + 4 + size) return null
        out.push(restBuf.subarray(eol + 2, eol + 2 + size))
        i = eol + 2 + size + 2
      }
    }

    const tryFinish = (fromEnd) => {
      if (done || !headersDone) return
      const status = Number((head.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0)
      const chunked = /transfer-encoding:\s*chunked/i.test(head)
      const lenM = head.match(/content-length:\s*(\d+)/i)
      let text = null
      if (chunked) {
        text = decodeChunked()
        if (text === null && fromEnd) text = restBuf.toString('utf8')
      } else if (lenM) {
        const need = Number(lenM[1])
        if (restBuf.length >= need) text = restBuf.subarray(0, need).toString('utf8')
        else if (fromEnd) text = restBuf.toString('utf8')
      } else if (fromEnd) {
        text = restBuf.toString('utf8')
      }
      if (text === null) return
      done = true
      socket.removeAllListeners('data')
      resolve({ status, text })
    }

    socket.on('data', (d) => {
      if (!headersDone) {
        restBuf = Buffer.concat([restBuf, d])
        const sep = restBuf.indexOf('\r\n\r\n')
        if (sep < 0) return
        head = restBuf.subarray(0, sep).toString('utf8')
        restBuf = Buffer.from(restBuf.subarray(sep + 4))
        headersDone = true
      } else {
        restBuf = Buffer.concat([restBuf, d])
      }
      tryFinish(false)
    })
    socket.on('end', () => tryFinish(true))
    socket.once('error', (e) => { if (!done) { done = true; reject(e) } })
    socket.setTimeout(timeoutMs || 30000, () => socket.destroy(new Error('请求超时')))
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    socket.write(body)
  })
}

/**
 * 发一条长帖。
 * @param {string} text 正文（可以远超 280）
 * @param {{ token:string, ct0:string, proxyUrl?:string, timeoutMs?:number }} opts
 * @returns {Promise<{ id:string, url:string, raw:any }>}
 */
export async function createNoteTweet(text, opts = {}) {
  const body = String(text ?? '').trim()
  if (!body) throw Object.assign(new Error('正文是空的'), { code: 'bad_request' })
  if (!opts.token || !opts.ct0) throw Object.assign(new Error('缺 TWITTER_AUTH_TOKEN / TWITTER_CT0'), { code: 'no_credential' })

  const payload = {
    variables: {
      tweet_text: body,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
      disallowed_reply_options: null,
    },
    queryId: QID,
    features: FEATURES,
  }
  const headers = {
    Authorization: 'Bearer ' + BEARER,
    Cookie: 'auth_token=' + opts.token + '; ct0=' + opts.ct0,
    'X-Csrf-Token': opts.ct0,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Client-Language': 'zh-cn',
    Origin: 'https://x.com',
    Referer: 'https://x.com/compose/post',
    Accept: '*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  }

  const raw = await openSocket(opts.proxyUrl, HOST, 443, opts.timeoutMs)
  let socket = raw
  try {
    if (!raw.encrypted) socket = await tlsOver(raw, HOST, opts.timeoutMs)
    const res = await httpPostJson(socket, '/i/api/graphql/' + QID + '/' + OP, payload, headers, opts.timeoutMs)
    let data = null
    try { data = JSON.parse(res.text) } catch { /* 保留原文 */ }
    if (res.status !== 200) {
      const msg = (data && data.errors && data.errors[0] && (data.errors[0].message || data.errors[0].code)) || ('HTTP ' + res.status)
      throw Object.assign(new Error('长帖发布失败：' + msg), { code: 'api_error', status: res.status, raw: data || res.text })
    }
    const id = data && data.data && data.data.notetweet_create && data.data.notetweet_create.tweet_results
      && data.data.notetweet_create.tweet_results.result && data.data.notetweet_create.tweet_results.result.rest_id
    if (!id) throw Object.assign(new Error('长帖返回里没有 rest_id（HTTP ' + res.status + '，body 长度 ' + String(res.text || '').length + '）：' + String(res.text || '').slice(0, 200)), { code: 'api_error', status: res.status, raw: data || String(res.text || '').slice(0, 500) })
    return { id: String(id), url: 'https://x.com/i/status/' + id, raw: data }
  } finally {
    try { socket.destroy() } catch { /* 已关 */ }
  }
}
