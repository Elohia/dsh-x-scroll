import { publishArticle } from '../lib/article.mjs'
import { graphqlPost } from '../lib/note.mjs'
import { resolveCredentials, resolveProxy } from '../lib/xcli.mjs'
const cred = await resolveCredentials({})
const px = await resolveProxy({})
const opts = { token: cred.token, ct0: cred.ct0, proxyUrl: px && px.ok ? px.url : '' }
const id = '2118542670247460865'
try {
  const r = await publishArticle(id, opts)
  console.log('PUBLISH ok, vars=', JSON.stringify(r.variables))
  console.log('URL https://x.com/i/articles/' + id)
} catch (e) {
  console.log('PUBLISH ERR', e.code, e.status, String(e.message).slice(0, 300))
  console.log('RAW', JSON.stringify(e.raw).slice(0, 500))
}
