import { readFileSync } from 'node:fs'
import { runGated } from '../lib/writegate.mjs'
import { postTweet } from '../lib/xcli.mjs'
const file = process.argv[2]
const text = readFileSync(file, 'utf8').trim()
const r = await runGated('post', { text, confirm: true }, async ({ text: t }) => postTweet(t))
console.log(JSON.stringify(r, null, 1).slice(0, 1500))
