# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-x-scroll`（中文名「**刷 X**」）：每天替用户刷一轮 X —— 按他填的方向搜帖、读原文和回复区，
提炼当天真正发生的事，写一份五节日报，并记账号涨粉数据。**默认只读**：写操作（点赞 / 关注 / 回复 / 发帖）默认全关，
开了也要过确认 / 额度 / 去重 / 台账闸门；没有私信。

排错前先读仓库根的 **CONTRACT.md**（唯一口径）；本文件只讲"怎么用、别踩什么"，两者冲突时以 CONTRACT 为准。

## 写东西之前先读语气

要写推文/回复/日报摘要时，先读 **`prompts/voice.md`**（来源：`elohia-double` 数字分身的本机语料）：
先短句再展开、说「写了个程序」不说「打造工作流」、禁营销词、数字必须真、结尾不喊口号。
发布前跑一遍 `node D:\elohia\scripts\assistant.mjs polish/check`。**分身只产草稿，本人确认才发。**

## 一句话流程

`x_status` 探通道 → 每方向 `x_search` → 挑精读 `x_tweet`（带回复区）→ 写 `out/<日期>.md` 五节 → 更新 `seen.md` → （可选，开关打开时）`x_write_status` + 少量写操作 → （可选）`x_deliver`。

## 什么时候用哪个工具

| 用户说 | 用 |
|---|---|
| "刷一轮 / 今天 X 上有什么 / 来份日报" | `x_run`（等它跑完，再看 `out/<日期>.md`） |
| "现在能跑吗 / 连不上 / 报错了" | `x_status`；还不行就 `node selfcheck.mjs`（人看的三段；`--json` 给机器） |
| "粉丝涨了吗 / 账号数据 / 曝光" | `x_growth` |
| "搜一下 XXX" | `x_search`（`query` 用关键词，别写一整句话） |
| "看看 @某人 / 他最近发什么" | `x_user` / `x_posts` |
| "这条帖讲了什么 / 评论区" | `x_tweet`（`id` 或 `url`） |
| "把今天的日报发我 / 发邮件" | `x_deliver`（`all` / `session` / `mail` / `toast`） |
| "以后的日报推到当前会话" | `x_bind_session` |
| "改个设置 / 换方向 / 换代理" | `x_config`（字段见 README 设置表） |
| "看看写操作能不能动手 / 今天做了几次" | `x_write_status`（开关 + 今日已用/上限 + 台账最后 5 条） |
| "把这条点个赞 / 关注他 / 回复这句 / 发这条" | `x_like` / `x_follow` / `x_reply` / `x_post`（**先看下面「写操作」节**） |
| "缺依赖 / 装不上 / 能不能一键装" | `x_setup`（`check` / `install`）；或 `node selfcheck.mjs` 看「④ 依赖」 |

## 日报在哪

- 日报：`$DSH_HOME/x-duty/out/<YYYY-MM-DD>.md`（`$DSH_HOME` 默认 `~/.dsh`；可用 `X_DUTY_HOME` 覆盖整个家目录）
- 配了 `mirrorDir` 会再复制一份到那里
- 判重表：`$DSH_HOME/x-duty/seen.md`；日志：`$DSH_HOME/x-duty/duty.log`
- 配置：`$DSH_HOME/x-duty/config.json`（**不含 token；SMTP 授权码优先在 DSH credentials 的 `X_SMTP_PASS`**）

## 装 / 排查顺序（桌面版实测）

1. 侧栏 **插件 → 添加插件**，填本仓库**绝对路径**，安装。
   桌面版 profile 由 Electron 独占：`dsh plugin --profile desktop add ...` 会被拒（`profile "desktop" is managed exclusively by the Electron application`）。命令行 profile 才用 `dsh plugin --profile <name> add "link:<路径>"`。
2. **重启 DSH**（bundle 层重启才组装）。
3. `cd <仓库> && node selfcheck.mjs` —— 四段（环境/凭据/连通/依赖）全 ✓ 再继续（`--json` 给机器）；缺依赖就在设置页「依赖自检 / 一键安装」点一下，或看「④ 依赖」给的命令。
4. 设置 → **刷 X** → 等「**环境自检**」跑完（点「**重新自检**」可重跑）→「现在跑一轮」；进度看 `duty.log`。
5. 要邮件才 `npm install --omit=dev`（只装 nodemailer；不装不影响别的通道）。

## 写操作：什么时候可以动手、怎么收口

写操作 = 点赞 / 关注 / 回复 / 发帖。**默认全关**：「能不能」由设置页开关决定，「多少」由每日额度决定，「做过什么」由台账决定。

- **动手前**：先 `x_write_status`。总闸/单项开关没开 ⇒ 直接告诉用户"写操作关着"，**不要**替他打开、不要绕。
- **只有同时满足才调写工具**：
  1. 用户**明确要求**做这件事（"把这条点个赞 / 关注他 / 回复这句 / 发这条"）；
  2. 设置页对应开关已打开（总闸 + 单项）；
  3. 回复/发帖：用户批准了**具体文案**，且你传 `confirm:true`（`*RequireConfirm` 为 true 时）。
- **一次只做用户点名的那一条/几条**：不扩大范围、不顺手点赞、不批量、不自动回关、不为用满额度动手。
- **被拒就停**：`{ok:false, blocked, reason}` 把原因告诉用户，别改参数重试、别拆单绕额度、别直接调 `twitter.exe` 写命令。
- **失败不连着重试**：回复/发帖失败先看错误；同一条最多再试一次，仍失败就停（防重复发）。
- **收口（每次动手后都要做）**：
  1. 告诉用户：做了什么、对谁、结果（含 blocked 原因）；
  2. 日报「本轮动手」记一行；台账由插件写，**你不要手写**。
- **绝不**：批量自动回复/关注/点赞、互赞互关、自动回关、私信（无能力）、替用户决定"发/不发"。
- **用户喊停**：关总闸 `allowWrite`（`x_config` 或设置页），不是只关某个单项。
- **语气**：回复/发帖的"像你本人"由用户自己的写作 skill 提供（推荐 `elohia-double` 数字分身）。
  插件**不内置、不合并、不读取**它的语料，只提供闸门与台账；**不要**把人格/语料复制进插件、日报或配置。

## 硬约束（都是实测撞出来的，别改回去）

- **凭据只注入子进程环境**：从 `process.env` 或 `HKCU\Environment` 读 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`，
  **绝不打印、绝不写文件、绝不进日志/日报**。自检只报"有/无"和来源。
- **代理顺序**（与 `lib/xcli.mjs` 一致）：配置 `proxy` → `X_PROXY` → `TWITTER_PROXY` / `HTTPS_PROXY` 等 → 探测 `127.0.0.1:7890` → `7892`（**已死，只作回退**）→ 系统代理。
  全不通就返回失败对象，**不要抛异常**，更不要硬跑一轮。机器本来就在墙外可填 `direct`（或 `X_DIRECT=1`）。
- **twitter-cli 定位顺序**（`lib/xcli.mjs` 与 `selfcheck.mjs` 一致）：配置 `twitterBin` → `X_TWITTER_BIN` → 常见安装位置（`~/.local/bin`、pipx、Python Scripts）→ PATH；显式指定的路径不可用要**直接报错**，不偷偷换。
- **twitter-cli 输出形状**：`{"ok":true,"schema_version":"1","data":{...}}`（0.8.5 实测）。
  只读子命令：`status` / `whoami` / `search` / `user` / `user-posts` / `tweet` / `followers` / `following`。
- **默认只读**：不要调 `post` / `reply` / `like` / `retweet` / `follow` / `bookmark` 这些 CLI 写子命令。
  写只能走 `x_like` / `x_follow` / `x_reply` / `x_post`，且必须开关打开 + 过闸门；不要"帮用户顺手点个赞"。
- **写操作闸门**（CONTRACT v0.2）：① 总闸 `allowWrite` → ② 单项开关 → ③ `confirm`（`replyRequireConfirm` / `postRequireConfirm`）→ ④ 当日额度 → ⑤ 去重 → ⑥ 内容闸门（长度 / 语感 / 链接）→ ⑦ 执行 → ⑧ 写台账。
  拿 `{ok:false, blocked, reason}` 就停：不改参数重试、不拆单绕额度、不换工具绕。
- **写操作台账 / 去重**：`$DSH_HOME/x-duty/write-ledger.jsonl`（**只追加**，回复只存前 40 字，不存凭据）与 `write-seen.json`。
  台账由插件写，**你别手写**；日报「本轮动手」只记一行结论。
- **写操作失败不连续重试**：回复/发帖失败先看错误，同一条最多再试一次（防重复发）。
- **没通道不跑**：`x_status` / `x_whoami` 失败 ⇒ 这一轮写失败日报（五节照留，说明卡在哪 + 探测结果），不编内容。
- **429 / 限流**：停手，不重试第二次；`riskCooldownHours` 冷却期内连手动 `x_run` 也拒绝，别绕。
- **报告计数口径**：宿主只数「值得回的帖」里 `### <纯数字推文 ID>` 的标题行。改日报格式要同步改 index.js 的计数逻辑；
  「热点与事件」里的标题别写成纯数字。
- **链接只能来自本轮工具返回**：用工具给的 `url`，或由 `id` 拼 `https://x.com/i/status/<id>`；别拿 handle 猜。
- **章程升级走记账制**（`charter.sha256`）：用户改过 `duty.md` 就一个字不动，新版另存 `duty.md.new`。
- **家目录不写插件目录**：配置/报告/日志全在 `$DSH_HOME/x-duty/`；装进 node_modules 后包目录可能只读、升级会被覆盖。
- **依赖安装只装依赖**：`x_setup install` / 设置页「一键安装缺失依赖」只跑 npm / pnpm / pipx（缺 nodemailer、twitter-cli），
  **不**调用 twitter-cli 业务命令、**不**碰账号；日志写 `$DSH_HOME/x-duty/install.log`。装 Node/Python 本体、配代理/凭据都不是一键安装的事。
- **语言风格不内置**：`elohia-double` 是用户自己的 skill，插件不内置、不合并、不读取其语料；别替用户复制人格或语料进来。
- **定时器 / 子进程回调里绝不让异常外冒**：未捕获异常会杀掉整个 DSH 宿主。

## 这个仓库现在有什么

- `index.js` —— host 半端：`x_*` 工具注册 + `x_setup` + 每天定时器 + `/api/x-duty/*`（含 `/deps`、`/install`）+ 配置 + 起一轮 + 镜像 + 投递；写操作在宿主侧先过一遍开关（fail-closed）
- `client.js` —— 设置页（侧栏「刷 X」），含「写操作」区块（总闸/四项开关/确认/额度/回复闸门）与「依赖自检 / 一键安装」区块
- `server/mcp_server.mjs` —— 内置 MCP（stdio JSON-RPC）：把 `x_*` 转发给 twitter-cli；写工具的闸门/额度/台账在这一层
- `lib/` —— `xcli.mjs`（twitter-cli 封装：定位二进制、注入凭据、代理探测、读/写子命令）/ `writegate.mjs`（写操作 8 道闸 + 台账/去重）/ `deps.mjs`（依赖体检 + 一键安装）/ `state.mjs`（家目录、章程升级、日期）/ `mcp.mjs`（stdio JSON-RPC 客户端）/ `hostdeps.mjs`（从宿主树取 `defineTool`）/ `deliver.mjs`（会话投递 + 邮件 + 通知 + 摘要抽取）
- `prompts/duty.md` —— 一轮要做的事 + 五节日报格式 + 写操作节（用户可改）
- `selfcheck.mjs` —— 零依赖环境自检（环境 / 凭据 / 连通 / 依赖四段；含写操作开关；退出码 0 或 2）
- `CHANGELOG.md` —— 版本变更（0.2.0 写操作、0.2.1 依赖与一键安装）
- `CHANGELOG.md` —— 版本变更（0.2.0 起有写操作）

## 已知残留（改造中，别按旧注释猜）

- 骨架从上一代插件抄来（见文末「出处」），个别文件（如 `lib/state.mjs` 的路径注释、`lib/deliver.mjs` 的日报摘要正则）可能还留着旧文案/旧标题匹配。
  行为以 CONTRACT 与代码实际为准；发现不一致先记下来，别照着注释改方向。
- **`lib/deliver.mjs` 里还有上一代品牌的残留**（不在本轮改造范围）：桌面通知兜底标题、会话消息 id 前缀、
  摘要抽取正则都还是旧文案/旧标题匹配。投递时看到旧品牌痕迹，就改这个文件（属于另一块写范围），
  别在文档里伪造它已经改好。

## 出处

仿照 dsh-xhs-scroll（小红书版）改造；更上游骨架来自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）。
