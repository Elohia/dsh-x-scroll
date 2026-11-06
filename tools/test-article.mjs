import { createArticleDraft } from '../lib/article.mjs'
import { resolveCredentials, resolveProxy } from '../lib/xcli.mjs'
const cred = await resolveCredentials({})
const px = await resolveProxy({})
console.log('proxy', px && px.ok ? px.url : '(direct)')
const md = '# 测试文章草稿（链路验证）\n\n这是第一段正文，用来验证 ArticleEntityDraftCreate。\n\n## 小节\n\n- 要点一\n- 要点二\n\n> 引用一句。\n'
try {
  const r = await createArticleDraft({ markdown: md, opts: { token: cred.token, ct0: cred.ct0, proxyUrl: px && px.ok ? px.url : '' } })
  console.log('DRAFT', r.id, r.title, 'blocks=', r.contentState.blocks.length)
} catch (e) {
  console.log('ERR', e.code, e.status, String(e.message).slice(0, 300))
  console.log('RAW', JSON.stringify(e.raw).slice(0, 400))
}
