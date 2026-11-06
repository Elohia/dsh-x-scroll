import { graphqlPost } from '../lib/note.mjs'
import { resolveCredentials, resolveProxy } from '../lib/xcli.mjs'
const cred = await resolveCredentials({})
const px = await resolveProxy({})
const opts = { token: cred.token, ct0: cred.ct0, proxyUrl: px && px.ok ? px.url : '' }
const r = await graphqlPost('ArticleEntityDelete', 'e4lWqB6m2TA8Fn_j9L9xEA', { variables: { articleEntityId: '2118546272844156928' }, features: {}, queryId: 'e4lWqB6m2TA8Fn_j9L9xEA' }, opts)
console.log('deleted:', JSON.stringify(r.data).slice(0, 120))
