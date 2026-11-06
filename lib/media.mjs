/**
 * lib/media.mjs —— 媒体上传（图片）：upload.x.com 的 INIT / APPEND / FINALIZE
 * ============================================================================
 * 文章正文插图、封面图都要先换成 media_id：
 *   ① INIT      ?command=INIT&total_bytes=N&media_type=image/png&media_category=tweet_image
 *   ② APPEND    ?command=APPEND&media_id=..&segment_index=0   multipart 字段名 media
 *   ③ FINALIZE  ?command=FINALIZE&media_id=..   （gif/视频会返回 processing_info，需要 STATUS 轮询）
 * 注意两处 media_category 不同：上传用 tweet_image，正文引用用 DraftTweetImage。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBin } from './xcli.mjs'

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'
const HOST = 'upload.x.com'
const UPLOAD_PATH = '/i/media/upload.json'

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
}

function headersOf(opts, extra) {
  return Object.assign({
    Authorization: 'Bearer ' + BEARER,
    Cookie: 'auth_token=' + opts.token + '; ct0=' + opts.ct0,
    'X-Csrf-Token': opts.ct0,
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Client-Language': 'zh-cn',
    Origin: 'https://x.com',
    Referer: 'https://x.com/',
    Accept: '*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  }, extra || {})
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/**
 * 上传一份媒体字节（走 Python 助手 + curl_cffi：Node 的 TLS 指纹过不了 upload.x.com 的 Cloudflare）
 * @param {{bytes:Buffer, mime:string, filename?:string}} media
 * @param {{token:string, ct0:string, proxyUrl?:string, pythonPath?:string, helperPath?:string, timeoutMs?:number}} opts
 * @returns {Promise<{mediaId:string, mediaCategory:string, processing:any}>}
 */
export async function uploadMedia(media, opts) {
  if (!opts || !opts.token || !opts.ct0) throw Object.assign(new Error('缺 TWITTER_AUTH_TOKEN / TWITTER_CT0'), { code: 'no_credential' })
  const py = opts.pythonPath || (await resolvePython())
  const helper = opts.helperPath || join(dirname(fileURLToPath(import.meta.url)), 'upload_helper.py')
  const payload = JSON.stringify({
    token: opts.token,
    ct0: opts.ct0,
    proxy: opts.proxyUrl || '',
    bytes_b64: media.bytes.toString('base64'),
    mime: media.mime || 'image/png',
    filename: media.filename || 'blob',
  })
  const out = await new Promise((resolve, reject) => {
    const child = spawn(py, [helper], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} ; reject(Object.assign(new Error('媒体上传超时'), { code: 'timeout' })) }, opts.timeoutMs || 180000)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error('起不了 Python 助手：' + e.message), { code: 'no_python' })) })
    child.on('close', (code) => {
      clearTimeout(timer)
      let js = null
      try { js = JSON.parse(stdout.trim().split('\n').pop()) } catch { /* 保留原文 */ }
      if (!js) return reject(Object.assign(new Error('助手输出不是 JSON（code=' + code + '）：' + (stdout || stderr).slice(0, 200)), { code: 'api_error' }))
      if (!js.ok) return reject(Object.assign(new Error('媒体上传失败：' + (js.error || '未知')), { code: 'api_error' }))
      resolve(js)
    })
    child.stdin.end(payload)
  })
  return { mediaId: String(out.media_id_string), mediaCategory: out.media_category || 'DraftTweetImage', processing: out.processing || null }
}

/** 找 Python：X_PYTHON → twitter-cli 同目录的 python → PATH 的 python */
export async function resolvePython(opts = {}) {
  const cands = []
  const push = (p, source) => { if (p && !cands.some((c) => c.path === p)) cands.push({ path: p, source }) }
  push(process.env.X_PYTHON, 'env:X_PYTHON')
  push(opts.pythonPath, 'config')
  try {
    const bin = await resolveBin({})
    if (bin && bin.path) push(join(dirname(bin.path), 'python.exe'), 'twitter-bin')
  } catch { /* 没装 CLI 也能继续猜 */ }
  const localAppData = process.env.LOCALAPPDATA || ''
  if (localAppData) push(join(localAppData, 'pipx', 'pipx', 'venvs', 'twitter-cli', 'Scripts', 'python.exe'), 'pipx')
  push('python', 'PATH')
  for (const c of cands) {
    const ok = await new Promise((res) => {
      const child = spawn(c.path, ['-c', 'import curl_cffi'], { windowsHide: true })
      child.on('error', () => res(false))
      child.on('close', (code) => res(code === 0))
    })
    if (ok) return c.path
  }
  throw Object.assign(new Error('找不到带 curl_cffi 的 Python（装 twitter-cli 时应该带上了）。设置 X_PYTHON 指向它，或 pipx install twitter-cli'), { code: 'no_python' })
}

/** 从本地文件读字节并推断 mime */
export function readLocalMedia(path) {
  const bytes = readFileSync(path)
  const ext = extname(path).toLowerCase()
  return { bytes, mime: MIME[ext] || 'application/octet-stream', filename: path.split(/[\\/]/).pop() }
}

export { MIME }
