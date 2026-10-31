# CONTRACT · dsh-x-scroll v0.1.0

> 本文件是三个并行改造的唯一口径。基线 = 从 `dsh-xhs-scroll` 复制来的骨架（已有 index.js / client.js / lib / server / prompts）。
> 目标：把「刷小红书」改成「刷 X（Twitter）」，**读为主**，不碰点赞/关注/发帖。

## 0 命名与目录（硬规则）

| 项 | 旧（xhs） | 新（x） |
|:--|:--|:--|
| 插件 id（`export const name`） | `xhs-scroll` | `x-scroll` |
| npm 包名 | `dsh-xhs-scroll` | `dsh-x-scroll` |
| 家目录 | `$DSH_HOME/xhs-duty/` | `$DSH_HOME/x-duty/` |
| 环境变量前缀 | `XHS_*` | `X_*`（`X_DUTY_HOME`、`X_TWITTER_BIN`、`X_PROXY`） |
| API 路由 | `/api/xhs-duty/*` | `/api/x-duty/*` |
| 工具前缀 | `xhs_` | `x_` |
| SMTP credential 引用 | `XHS_SMTP_PASS` | `X_SMTP_PASS` |
| 平台脚本 | `server/mcp_server.mjs`（Playwright） | **同名文件重写**（twitter-cli，Node 版，不改文件名） |

**禁止**在成品里留 `xhs` / `小红书` 字样（README 里「仿照 dsh-xhs-scroll」这类出处说明可以留在 AGENTS.md）。

## 1 MCP server 契约（`server/mcp_server.mjs`）

协议层（JSON-RPC over stdio：initialize / tools/list / tools/call / notifications/cancelled）**照抄** baseline 的实现，只换 handler。
工具（名字与参数必须一致，index.js 会逐一转发）：

| 工具 | 参数 | 返回要点 |
|:--|:--|:--|
| `x_status` | — | `{ok, proxy:{url,source}, cred:{ok}, cli:{bin,version}, account:{needLogin}}` |
| `x_whoami` | — | `{ok, handle, name, followers, following, tweets, verified, createdAt}` |
| `x_search` | `{query, limit?, sort?}` | `{ok, query, count, posts:[{id,url,author,authorFollowers,verified,text,likes,replies,retweets,createdAt}], error?}` |
| `x_user` | `{handle}` | `{ok, handle, name, bio, followers, following, tweets, verified, createdAt, url}` |
| `x_posts` | `{handle, limit?}` | `{ok, handle, count, posts:[同上结构]}` |
| `x_tweet` | `{id` 或 `url`}` | `{ok, id, url, text, author, metrics, createdAt, replies:[{author,text,likes,createdAt}]}` |
| `x_growth` | `{}` | `{ok, handle, followers, following, tweets, verified, blueRatio?, recent:{avgViews,maxViews,posts}}` |

数据来源统一走 `twitter.exe`（twitter-cli 0.8.5，路径 `C:\\Users\\elohi\\.local\\bin\\twitter.EXE`，可用 `X_TWITTER_BIN` 覆盖）。
- 认证：从进程环境或 **HKCU\\Environment** 读 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`（**只注入子进程 env，绝不打印、绝不落盘**）。
- 代理：`X_PROXY` → 探测 `127.0.0.1:7890`（活）→ `7892`（死，留作回退）→ HKCU Internet Settings；全不通返回 `{ok:false, error}`，**不要抛异常**。
- 只读：本 server **不实现** 发帖/点赞/回复/关注。拿到的 JSON 用 `tools/call` 原样结构化返回。
- 命令示例（写死在 lib/xcli.mjs，不散落）：`twitter whoami --json`、`twitter search "<q>" -n 20 --json`、`twitter user <h> --json`、`twitter user-posts <h> -n 20 --json`、`twitter tweet <id> --json`。

## 2 host 插件契约（`index.js`）

- `export const name = 'x-scroll'`；`export const inject = ['webServer','tools']`。
- 注册的工具（`defineTool`）：`x_status` `x_config` `x_whoami` `x_search` `x_user` `x_posts` `x_tweet` `x_growth` `x_run` `x_deliver` `x_bind_session`（后三个是 host 自有，不走 MCP；`x_config` 也是 host 自有）。
- `x_search/x_user/x_posts/x_tweet/x_growth/x_status` 转发给 MCP。
- 定时：`runAt`（默认 `09:30`）跑一轮；`catchUp` 补跑；窗口逻辑沿用 `lib/state.mjs`。
- 路由：`GET /api/x-duty/status`、`GET|POST /api/x-duty/config`、`POST /api/x-duty/run`、`GET /api/x-duty/report?day=`、`GET /api/x-duty/selfcheck`（原扫码登录路由删除）。
- 登录门禁改成：`x_status`/`x_whoami` 成功即视为可用；失败则不允许起跑（写日报说明原因）。
- 状态目录里必须有：`config.json` `state.json` `duty.log` `out/<date>.md` `seen.md`。

## 3 配置字段（config.json）

```
enabled:true, runAt:'09:30', catchUp:true,
directions:'AI / agent 与开源\n独立开发 / 出海收款\nA股工具与数据',   // 一行一个方向
perDirection:20, deepRead:8, sort:'general', readReplies:true,
reportLevel:'full', mirrorDir:'', workspace:'', headlessProfile:'headless', dshBin:'', overlayMcp:true,
twitterBin:'', proxy:'',
sessionTarget:'off|latest|fixed', sessionId:'', sessionSpeak:true,
deliverMail:false, smtpHost:'smtp.qq.com', smtpPort:465, smtpSecure:true, smtpUser:'', smtpFrom:'', mailTo:'', smtpPass:'', deliverToast:false,
riskCooldownHours:24
```
（`channel`/`pythonPath` 这类浏览器专用字段**删掉**；`sort` 取值 `general|latest|popular` 映射到 CLI 的 `--sort`。）

## 4 duty 章程（`prompts/duty.md`）

一轮的产出必须是 `out/<日期>.md`，固定五节：
1. **今日一句话**（这一轮最值钱的一条信息）
2. **热点与事件**（按方向分组，每条带链接与一句「为什么值得看」）
3. **值得回的帖**（3-8 条：链接 / 赞·回数 / 建议角度，回复区竞争小的优先）
4. **账号数据**（粉丝、涨跌、近 10 条曝光；来源 `x_growth`）
5. **未决与风险**（限流、代理、口径未核实项）
铁律：**只读**；不编造数字；每条链接必须来自本轮工具返回。

## 5 各自验收（必须实跑贴输出）

- **T1（server）**：`node server/mcp_server.mjs` 手工喂 initialize + tools/list + tools/call(x_whoami) + tools/call(x_search) ，贴返回；坏代理下 x_status 必须返回 `ok:false` 而不是崩。
- **T2（ui/host）**：`node --check index.js`、`node --check client.js`；`node --check cordis.patch.yml`（yaml 用 node -e 读一遍）；`package.json` 能被 `node -e "JSON.parse(...)"` 解析；grep 全仓无 `xhs` 残留（AGENTS.md 出处说明除外）。
- **T3（charter）**：`prompts/duty.md` 含五节与只读铁律；`README.md` 的安装命令可照抄执行；`selfcheck.mjs` 能跑出结果并退出码 0。


---

# CONTRACT v0.2 · 写操作（点赞 / 关注 / 回复 / 发帖）

> 2026-10-31 用户指令：「点赞、关注、回复、发帖，也放进去，但是要加开关」。
> 原则：**默认全关；开关只解决"能不能"，额度解决"多少"，台账解决"可追"。**

## 1 配置字段（新增，config.json）

```
allowWrite:false,        // 总闸：false 时下面四个开关一律无效（fail-closed）
allowLike:false,         // 点赞
allowFollow:false,       // 关注
allowReply:false,        // 回复
allowPost:false,         // 发帖（含引用转推）
replyRequireConfirm:true,// 回复前要 confirm:true
postRequireConfirm:true, // 发帖前要 confirm:true
maxLikesPerDay:20,
maxFollowsPerDay:10,
maxRepliesPerDay:5,
maxPostsPerDay:3,
replyMinChars:15,        // 回复正文下限（治"说得好"）
replyAllowLinks:false,   // 回复里是否允许放链接（冷启动期应关）
```

## 2 新增 MCP 工具（server/mcp_server.mjs）

| 工具 | 参数 | 行为 |
|:--|:--|:--|
| `x_like` | `{id, confirm?}` | 已赞过 → 拒绝；超额度 → 拒绝；写台账 |
| `x_follow` | `{handle, confirm?}` | 已关注 → 拒绝；超额度 → 拒绝；写台账 |
| `x_reply` | `{id, text, confirm?}` | 过语感/长度/链接闸门；超额度 → 拒绝；写台账 |
| `x_post` | `{text, confirm?, replyTo?}` | 字数≤280 加权；超额度 → 拒绝；写台账；返回 tweet id/url |
| `x_write_status` | `{}` | 返回四个开关 + 今日已用/上限 + 台账最后 5 条 |

**闸门顺序（每个写工具都必须逐条过，缺一不可）**：
① 总闸 `allowWrite` → ② 单项开关 → ③ `confirm`（若 require）→ ④ 当日额度 → ⑤ 去重（台账/seen）→ ⑥ 内容闸门（仅 reply/post）→ ⑦ 执行 → ⑧ 写台账。
**任何一条不过：返回 `{ok:false, blocked:'<哪条闸门>', reason:'中文原因'}`，绝不执行。**

## 3 台账与去重

- 台账：`$DSH_HOME/x-duty/write-ledger.jsonl`（**只追加**），每行 `{ts,action,target,ok,tweetId,blocked,note}`；**不写凭据、不写正文全文**（回复只存前 40 字）。
- 去重：`$DSH_HOME/x-duty/write-seen.json` `{liked:{id:ts}, followed:{handle:ts}, replied:{id:ts}, posted:{id:ts}}`。
- 语感闸门（reply）：开头八股黑名单（说得好/学习了/支持/顶/感谢分享/受教了…）、纯表情、与最近 20 条自己回复的 bigram 相似度 >0.8、长度 < replyMinChars、含链接而 replyAllowLinks=false ⇒ 一律拒。

## 4 宿主侧（index.js / client.js）

- 注册 `x_like / x_follow / x_reply / x_post / x_write_status` 五个工具（转发 MCP）。
- 设置页新增「写操作」区块：一个总闸 + 四个开关 + 两个确认开关 + 四个额度 + 回复字数下限/链接开关；总闸关时其余置灰。
- `x_status` 返回值里加 `write:{allowWrite, allowLike, allowFollow, allowReply, allowPost, today:{...}}`，让日报能看到"今天能不能动手、动了几次"。

## 5 duty 章程（prompts/duty.md）新增一节

「## 写操作（只有开关打开时才做）」：
- 开关没开 ⇒ 连想都别想，日报里只列「值得回的帖」。
- 开关开了 ⇒ 回复只回「值得回的帖」里排前 3 的，每条必须带一个具体信息（数字/反例/可执行动作）；点赞只给真正读过的；关注只给「连续两次看到他发同类好帖」的；发帖只在有实测回执时发。
- **宁可少做，不许刷量**；每次动手在日报里记一行（做了什么、对谁、为什么）。
