/**
 * lib/article.mjs —— X Article（文章）：草稿 / 发布 / 封面，含图片、代码块、内嵌帖子
 * ============================================================================
 * 分层：
 *   1) markdown -> Draft.js content_state（blocks + entity_map，实体 key 全局递增）
 *   2) 上传图片拿 media_id（lib/media.mjs）
 *   3) ArticleEntityDraftCreate -> ArticleEntityPublish ->（可选）UpdateCoverMedia
 *
 * 实体支持：
 *   MEDIA   独占一行的 ![alt](src)      media_category: DraftTweetImage / DraftTweetGif / DraftTweetVideo
 *   MARKDOWN 三反引号代码块             data.markdown 前后带换行，X 端按 markdown 渲染
 *   TWEET   独占一行的 x.com/.../status/<id>   data 只放 tweet_id
 *   DIVIDER ---
 *   LINK    未接（正文里的普通链接按纯文本处理）
 *
 * 已知约束（实测口径）：
 *   - block type 只有两级标题；header-three / code-block 会过 GraphQL 校验但后端 OperationalError。
 *   - 不要发 depth；inline_style_ranges.style 只认 Bold / Italic / Strikethrough。
 *   - entity key 从 0 起、按文档顺序递增；MEDIA 的 local_media_id 必须等于自身 key。
 * ============================================================================
 */
import { randomBytes } from 'node:crypto'
import { graphqlPost } from './note.mjs'
import { uploadMedia } from './media.mjs'

const QID_DRAFT = 'g1l5N8BxGewYuCy5USe_bQ'
const QID_DRAFT_ALT = 'fCkdrI6zrnw_UtVa3WDHhw'
const QID_PUBLISH = '86zqyWZeIoccSyBxmxcd6w'
const QID_COVER = 'AbzX20PDk6TTzqmN67hiPQ'

const FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: false,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
}
const FEATURES_COVER = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
}
const FIELD_TOGGLES = { withPayments: false, withAuxiliaryUserLabels: false }

const key5 = () => randomBytes(3).toString('base64url').slice(0, 5)
const TWEET_URL = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/

/** 从 markdown 里扫出所有图片 src（保持出现顺序、去重） */
export function collectImageSrcs(markdown) {
  const out = []
  const re = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g
  let m
  while ((m = re.exec(String(markdown ?? '')))) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/**
 * markdown -> content_state
 * @param {string} markdown
 * @param {{media?: Record<string,{mediaId:string,mediaCategory:string}>}} opts
 */
export function mdToContentState(markdown, opts) {
  const media = (opts && opts.media) || {}
  const src = String(markdown ?? '').replace(/\r\n/g, '\n')
  const blocks = []
  const entityMap = []
  let entityKey = 0

  const pushBlock = (type, text, ranges) => {
    blocks.push({ key: key5(), type, text: text, data: {}, entity_ranges: ranges || [], inline_style_ranges: [] })
  }
  const pushAtomic = (entity) => {
    entityMap.push({ key: entityKey, value: entity })
    pushBlock('atomic', ' ', [{ key: entityKey, offset: 0, length: 1 }])
    entityKey += 1
  }

  const lines = src.split('\n')
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // 代码块
    if (/^\x60{3}/.test(trimmed)) {
      const lang = trimmed.replace(/^\x60{3}/, '').trim() || 'plaintext'
      const buf = []
      i += 1
      while (i < lines.length && !/^\x60{3}/.test(lines[i].trim())) { buf.push(lines[i]); i += 1 }
      i += 1
      const fence = '\x60\x60\x60'
      pushAtomic({ type: 'MARKDOWN', mutability: 'Mutable', data: { markdown: '\n' + fence + lang + '\n' + buf.join('\n') + '\n' + fence + '\n' } })
      continue
    }

    if (!trimmed) { i += 1; continue }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { pushAtomic({ type: 'DIVIDER', mutability: 'Immutable', data: {} }); i += 1; continue }

    // 独占一行的图片
    const img = trimmed.match(/^!\[[^\]]*\]\(([^)\s]+)[^)]*\)$/)
    if (img) {
      const info = media[img[1]]
      if (info && info.mediaId) {
        pushAtomic({ type: 'MEDIA', mutability: 'Immutable', data: { media_items: [{ local_media_id: entityKey, media_id: String(info.mediaId), media_category: info.mediaCategory || 'DraftTweetImage' }] } })
      }
      i += 1
      continue
    }

    // 独占一行的推文链接
    const tw = trimmed.match(TWEET_URL)
    if (tw) { pushAtomic({ type: 'TWEET', mutability: 'Immutable', data: { tweet_id: tw[1] } }); i += 1; continue }

    if (/^#{2}\s+/.test(trimmed)) { pushBlock('header-one', trimmed.replace(/^#{2}\s+/, '')); i += 1; continue }
    if (/^#{3,}\s+/.test(trimmed)) { pushBlock('header-two', trimmed.replace(/^#{3,}\s+/, '')); i += 1; continue }
    if (/^#\s+/.test(trimmed)) { pushBlock('header-one', trimmed.replace(/^#\s+/, '')); i += 1; continue }
    if (/^>\s?/.test(trimmed)) { pushBlock('blockquote', trimmed.replace(/^>\s?/, '')); i += 1; continue }
    if (/^[-*]\s+/.test(trimmed)) { pushBlock('unordered-list-item', trimmed.replace(/^[-*]\s+/, '')); i += 1; continue }
    if (/^\d+\.\s+/.test(trimmed)) { pushBlock('ordered-list-item', trimmed.replace(/^\d+\.\s+/, '')); i += 1; continue }

    const buf = [trimmed]
    i += 1
    while (i < lines.length) {
      const t = lines[i].trim()
      if (!t) break
      if (/^#{1,6}\s/.test(t) || /^>/.test(t) || /^[-*]\s/.test(t) || /^\d+\.\s/.test(t) || /^(-{3,}|\*{3,})$/.test(t) || /^\x60{3}/.test(t) || /^!\[/.test(t)) break
      buf.push(t); i += 1
    }
    pushBlock('unstyled', buf.join(' '))
  }
  return { blocks, entity_map: entityMap }
}

/** 标题：优先显式 title，否则取第一个 # 行 */
export function titleOf(markdown, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim()
  const m = String(markdown ?? '').match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : ''
}

function findRestId(data) {
  let found = ''
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return
    if (typeof o.rest_id === 'string' && /^[0-9]{6,}$/.test(o.rest_id)) { found = o.rest_id; return }
    for (const v of Object.values(o)) walk(v)
  }
  walk(data)
  return found
}

/** 建草稿（已带 content_state，不含上传） */
export async function createArticleDraft(input) {
  const opts = input.opts || {}
  const contentState = input.contentState || mdToContentState(input.markdown, { media: input.media })
  if (!contentState.blocks.length) throw Object.assign(new Error('正文是空的'), { code: 'bad_request' })
  const articleTitle = titleOf(input.markdown, input.title)
  if (!articleTitle) throw Object.assign(new Error('缺标题（传 title，或在 markdown 里用 # 开头）'), { code: 'bad_request' })

  const payload = {
    variables: { content_state: contentState, title: articleTitle },
    features: FEATURES,
    fieldToggles: FIELD_TOGGLES,
    queryId: QID_DRAFT,
  }
  let res
  try {
    res = await graphqlPost('ArticleEntityDraftCreate', QID_DRAFT, payload, opts)
  } catch (e) {
    if (e && (e.status === 404 || e.status === 422)) {
      payload.queryId = QID_DRAFT_ALT
      res = await graphqlPost('ArticleEntityDraftCreate', QID_DRAFT_ALT, payload, opts)
    } else throw e
  }
  const id = findRestId(res.data)
  if (!id) throw Object.assign(new Error('建草稿成功但没找到 rest_id'), { code: 'api_error', raw: res.data })
  return { id, title: articleTitle, contentState, data: res.data }
}

/** 发布草稿 */
export async function publishArticle(id, opts) {
  const articleId = String(id || '').trim()
  if (!/^[0-9]{6,}$/.test(articleId)) throw Object.assign(new Error('article id 不合法：' + articleId), { code: 'bad_request' })
  const attempts = [{ articleEntityId: articleId }]
  let lastErr = null
  for (const variables of attempts) {
    try {
      const res = await graphqlPost('ArticleEntityPublish', QID_PUBLISH, { variables, features: FEATURES, queryId: QID_PUBLISH }, opts || {})
      const errs = res.data && res.data.errors
      if (Array.isArray(errs) && errs.length) {
        const e0 = errs[0] || {}
        const code = (e0.extensions && e0.extensions.code) || e0.code || ''
        const kind = (e0.extensions && e0.extensions.name) || e0.kind || ''
        const msg = String(e0.message || '')
        const friendly = (code === 344 || /daily limit/i.test(msg))
          ? '今日发送额度已用尽（X 侧限制，code 344）：等额度重置，或先删除不必要的历史推文。草稿是保住了的，可直接发布。'
          : '文章发布被拒：' + (code ? 'code ' + code + ' ' : '') + (kind ? kind + ' ' : '') + msg
        throw Object.assign(new Error(friendly), { code: 'api_error', status: res.status, raw: res.data })
      }
      return { data: res.data, variables }
    } catch (e) { lastErr = e }
  }
  throw lastErr || Object.assign(new Error('发布失败'), { code: 'api_error' })
}

/** 设置封面（先上传图片拿 media_id） */
export async function setCoverMedia(articleId, mediaId, opts) {
  const variables = { articleEntityId: String(articleId), coverMedia: { media_id: String(mediaId), media_category: 'DraftTweetImage' } }
  const res = await graphqlPost('ArticleEntityUpdateCoverMedia', QID_COVER, { variables, features: FEATURES_COVER, queryId: QID_COVER }, opts || {})
  return res.data
}

/** 删除文章（草稿或已发布的都行；发布后删除等于撤稿+删） */
export async function deleteArticle(articleId, opts) {
  const variables = { articleEntityId: String(articleId) }
  const res = await graphqlPost('ArticleEntityDelete', 'e4lWqB6m2TA8Fn_j9L9xEA', { variables, features: {}, queryId: 'e4lWqB6m2TA8Fn_j9L9xEA' }, opts || {})
  return res.data
}

/**
 * 端到端：上传图片 → 建草稿 → 设封面 → 发布
 * @param {{title?:string, markdown:string, images?:Record<string,string>, cover?:string, publish?:boolean, opts:object}} input
 *   images: markdown 里的 src -> 本地文件路径
 *   cover:  本地封面图路径
 */
export async function publishArticleFlow(input) {
  const opts = input.opts || {}
  const markdown = String(input.markdown ?? '')
  const fileMap = input.images || {}
  const media = {}
  const uploaded = []

  for (const src of collectImageSrcs(markdown)) {
    const path = fileMap[src] || src
    const media0 = await import('./media.mjs').then((m) => m.readLocalMedia(path))
    const up = await uploadMedia(media0, opts)
    media[src] = { mediaId: up.mediaId, mediaCategory: up.mediaCategory }
    uploaded.push({ src, path, mediaId: up.mediaId, mediaCategory: up.mediaCategory })
  }

  const contentState = mdToContentState(markdown, { media })
  const draft = await createArticleDraft({ title: input.title, markdown, contentState, opts })

  let cover = null
  if (input.cover) {
    const m = await import('./media.mjs').then((x) => x.readLocalMedia(input.cover))
    const up = await uploadMedia(m, opts)
    await setCoverMedia(draft.id, up.mediaId, opts)
    cover = up.mediaId
  }

  if (input.publish !== false) await publishArticle(draft.id, opts)
  return { id: draft.id, title: draft.title, url: 'https://x.com/i/articles/' + draft.id, published: input.publish !== false, uploaded, cover, contentState }
}
