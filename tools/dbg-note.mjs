import { createNoteTweet } from '../lib/note.mjs'
try {
  const r = await createNoteTweet('x'.repeat(300), { token: process.env.TWITTER_AUTH_TOKEN, ct0: process.env.TWITTER_CT0, proxyUrl: 'http://127.0.0.1:7890' })
  console.log('OK', JSON.stringify(r).slice(0,200))
} catch (e) {
  console.log('ERR', e.code, e.status, String(e.message).slice(0,300))
  console.log('RAW', JSON.stringify(e.raw).slice(0, 600))
}
