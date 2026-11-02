import { readFileSync } from 'node:fs'
import { runGated, weightedLength } from '../lib/writegate.mjs'
import { postTweet } from '../lib/xcli.mjs'

const file = process.argv[2]
const raw = readFileSync(file, 'utf8').trim()
const LIMIT = 262 // 留余量给 "n/m " 前缀

// 按段落切；段落超限再按句子切
function chunks(text) {
  const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  const out = []
  let buf = ''
  const push = () => { if (buf.trim()) { out.push(buf.trim()); buf = '' } }
  for (const p of paras) {
    const candidate = buf ? buf + '\n\n' + p : p
    if (weightedLength(candidate) <= LIMIT) { buf = candidate; continue }
    push()
    if (weightedLength(p) <= LIMIT) { buf = p; continue }
    // 段落本身超限：按句号切
    const sents = p.split(/(?<=[。！？!?])/).filter((s) => s.trim())
    for (const s of sents) {
      const c2 = buf ? buf + s : s
      if (weightedLength(c2) <= LIMIT) { buf = c2 } else { push(); buf = s }
    }
  }
  push()
  return out
}

const parts = chunks(raw)
const total = parts.length
console.log('thread parts:', total, parts.map((p) => weightedLength(p)).join(','))
let prev = ''
let first = ''
for (let i = 0; i < total; i++) {
  const text = total > 1 ? (i + 1) + '/' + total + ' ' + parts[i] : parts[i]
  const r = await runGated('post', { text, confirm: true }, async ({ text: t }) =>
    postTweet(t, prev ? { replyTo: prev } : {}))
  if (!r.ok) { console.log('FAIL at', i + 1, JSON.stringify(r).slice(0, 400)); break }
  const id = String(r.result?.data?.id || r.result?.id || r.entry?.tweetId || '')
  console.log('posted', i + 1, '/', total, 'id=', id)
  if (i === 0) first = id
  prev = id
}
console.log('first=', first)
