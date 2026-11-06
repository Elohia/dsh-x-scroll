/**
 * lib/article.mjs —— X Article（文章）发布：草稿 + 发布
 * ============================================================================
 * 与长帖（Note Tweet）不是一回事：
 *   长帖 = 一条推文，最多 25000 字符（lib/note.mjs 的 CreateNoteTweet）；
 *   文章 = 独立页面（标题 + 富文本 + 封面），走 ArticleEntityDraftCreate -> ArticleEntityPublish。
 * 两套都用同一份 cookie 凭据（auth_token + ct0）+ 公开 web bearer，不走官方 OAuth。
 *
 * 协议来源（2026-11 抓包整理）：
 *   草稿：POST /i/api/graphql/<qid>/ArticleEntityDraftCreate  qid=g1l5N8BxGewYuCy5USe_bQ
 *         variables = { content_state: { blocks, entity_map }, title }
 *   发布：POST /i/api/graphql/<qid>/ArticleEntityPublish       qid=86zqyWZeIoccSyBxmxcd6w
 * queryId 会轮换；草稿 404/422 时换备用 id fCkdrI6zrnw_UtVa3WDHhw。
 * ============================================================================
 */
import { randomBytes } from 'node:crypto'
import { graphqlPost } from './note.mjs'

const QID_DRAFT = 'g1l5N8BxGewYuCy5USe_bQ'
const QID_DRAFT_ALT = 'fCkdrI6zrnw_UtVa3WDHhw'
const QID_PUBLISH = '86zqyWZeIoccSyBxmxcd6w'

const FEATURES = {
  profile_label_improvements_pcf_label_in_post_enabled: false,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
}
const FIELD_TOGGLES = { withPayments: false, withAuxiliaryUserLabels: false }

const key5 = () => randomBytes(3).toString('base64url').slice(0, 5)

/** markdown -> X Article 的 content_state（段落 / 两级标题 / 引用 / 有序无序列表 / 分隔线） */
export function mdToContentState(markdown) {
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
    if (!trimmed) { i += 1; continue }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { pushAtomic({ type: 'DIVIDER', mutability: 'Immutable', data: {} }); i += 1; continue }
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
      if (/^#{1,6}\s/.test(t) || /^>/.test(t) || /^[-*]\s/.test(t) || /^\d+\.\s/.test(t) || /^(-{3,}|\*{3,})$/.test(t)) break
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

/** 建草稿。返回 { id, title, contentState, data } */
export async function createArticleDraft(input) {
  const markdown = input.markdown
  const opts = input.opts || {}
  const contentState = mdToContentState(markdown)
  if (!contentState.blocks.length) throw Object.assign(new Error('正文是空的'), { code: 'bad_request' })
  const articleTitle = titleOf(markdown, input.title)
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
    const st = e && e.status
    if (st === 404 || st === 422) {
      payload.queryId = QID_DRAFT_ALT
      res = await graphqlPost('ArticleEntityDraftCreate', QID_DRAFT_ALT, payload, opts)
    } else throw e
  }
  const id = findRestId(res.data)
  if (!id) throw Object.assign(new Error('建草稿成功但没找到 rest_id'), { code: 'api_error', raw: res.data })
  return { id, title: articleTitle, contentState, data: res.data }
}

/** 发布草稿。返回 { data, variables } */
export async function publishArticle(id, opts) {
  const articleId = String(id || '').trim()
  if (!/^[0-9]{6,}$/.test(articleId)) throw Object.assign(new Error('article id 不合法：' + articleId), { code: 'bad_request' })
  const attempts = [{ articleEntityId: articleId }, { article_id: articleId }]
  let lastErr = null
  for (const variables of attempts) {
    try {
      const res = await graphqlPost('ArticleEntityPublish', QID_PUBLISH, { variables, features: FEATURES, queryId: QID_PUBLISH }, opts || {})
      return { data: res.data, variables }
    } catch (e) { lastErr = e }
  }
  throw lastErr || Object.assign(new Error('发布失败'), { code: 'api_error' })
}
