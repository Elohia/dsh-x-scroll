import { postTweet } from '../lib/xcli.mjs'
const text = '长帖链路测试（插件内 CreateNoteTweet）——' + '这一段是为了验证超过 280 加权字符时自动切换长帖通道。'.repeat(6)
console.log('weight-ish chars', Array.from(text).length)
const r = await postTweet(text)
console.log(JSON.stringify(r).slice(0, 600))
