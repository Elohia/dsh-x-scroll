# dsh-x-scroll（刷 X）

每天替你刷一轮 X（Twitter）：**按你填的方向搜 → 读原帖和回复区 → 提炼当天真正发生的事 → 写一份日报**，
顺手记一下账号涨没涨。日报写到 `$DSH_HOME/x-duty/out/<日期>.md`。

> **默认只读。** 读工具随时可用；点赞 / 关注 / 回复 / 发帖（写操作）**默认全关** —— 只有你在设置页打开「写操作」总闸 + 单项开关，并过确认 / 额度 / 去重 / 内容闸门后才会动手。**没有私信**，也不加。

## 它干三件事

1. **按方向刷 X 读帖**：你填的每个方向搜一轮，按互动数据分层，挑出值得精读的读全文 + 回复区。
2. **写日报**：固定五节（今日一句话 / 热点与事件 / 值得回的帖 / 账号数据 / 未决与风险），每条带链接和"为什么值得看"。
3. **涨粉数据**：粉丝、关注、推文、蓝V、近 10 条曝光（来自 `x_growth`），以及和上一份日报的差值。

> 第四件是可选的：**写操作**（点赞 / 关注 / 回复 / 发帖），默认全关，见下面「写操作」一节 —— 开了也不会自动刷，「宁可少做，不许刷量」写进了章程和闸门。

## 它怎么工作

```
设置页（client.js）──/api/x-duty/*──▶ host 插件（index.js）
                                        │  ·每天 09:30 定时器（可改）
                                        │  ·注册 x_* 工具（给会话里的 AI 用）
                                        │  ·到点起一轮：dsh --profile headless --patch <overlay> <prompt>
                                        ▼
                          server/mcp_server.mjs（内置 MCP，stdio JSON-RPC）
                                        │  twitter-cli（twitter.exe 0.8.5；默认只调只读子命令，写操作要开关+闸门）
                                        ▼
                                     X（用你的登录态；凭据只注入子进程环境）
```

- **取数走 twitter-cli**：`twitter status/whoami/search/user/user-posts/tweet --json`，拿结构化 JSON，不抓页面 DOM。
- **认证**：从进程环境或 `HKCU\Environment` 读 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`，**只注入子进程 env，不打印、不落盘**。
- **代理**：设置页 `proxy` → `X_PROXY` → `TWITTER_PROXY` / `HTTPS_PROXY` 等 → 探测 `127.0.0.1:7890`（活）→ `7892`（回退）→ 系统代理设置；全不通就返回失败，不硬跑。显式指定的代理连不上会**直接报错**（不偷偷换别的）；机器本来就在墙外可填 `direct`（或设 `X_DIRECT=1`）直连。
- **凭据/代理任一不通 ⇒ 这一轮不跑**，只写一份"失败日报"说明卡在哪，不编造内容。
- **写操作多一道门**：`x_like` / `x_follow` / `x_reply` / `x_post` 先过宿主的「总闸 + 单项开关」，再过 MCP 的 8 道闸（确认 / 额度 / 去重 / 内容），最后写台账 —— 默认全关，关着就一条都不会发。

## 装

前置：**Node ≥ 22**（实测 v24 也可）、**twitter-cli 0.8.5**（实测可用；更老的版本字段可能对不上）、**一条能连 X 的代理**（默认探测 7890）。

### A. DSH 桌面版（推荐，当前用法）

1. 侧栏 **插件 → 添加插件**（或箭头菜单 → **安装第三方插件**）。
2. 在输入框里填**本仓库的绝对路径**，例如 `D:\dsh\dsh-x-scroll`，按提示安装（支持本地目录）。
3. **重启一次 DSH**（Electron 要重启才会组装 bundle）。
4. 打开 **设置 → 刷 X**，按需填代理 / twitter 二进制：页面里的「**环境自检**」会自动跑一次（点「**重新自检**」可手动重跑），看到 ✓ 再点「**现在跑一轮**」。

> ⚠️ 桌面版 profile 由 Electron 独占，命令行 `dsh plugin --profile desktop add ...` 会被拒绝
> （实测 DSH 0.1.5-rc.2：`profile "desktop" is managed exclusively by the Electron application`）。
> 桌面版就从上面第 1 步的图形入口装。

### B. 命令行 profile（web / tui / headless）

```powershell
dsh plugin --profile <profile 名> add "link:<本仓库绝对路径>"
# 然后重启那个 profile 的 dsh
```

### C. 跑之前先自检（强烈建议）

```powershell
cd <本仓库绝对路径>
node selfcheck.mjs
```

零依赖，查四段并给人看的输出：① 环境（twitter 二进制 / CLI 版本 / 代理端口，顺带一行「**写操作：全关 / 已开 N 项**」）
② 凭据有没有（不显示值）③ 连通（真跑一次 `twitter status --json` 看账号）④ 依赖（node / twitter-cli / nodemailer / 家目录，缺项给修复命令）。
**退出码 0 = 全通；2 = 有必须项缺**（nodemailer 缺只提示，不算失败）。要机器读就加 `--json`。

## 长帖怎么发（>280 加权）

**简短版**：写就行了，插件自己切通道。

- **≤280 加权** → 普通推文（X 的 `CreateTweet`）。
- **>280 加权** → 长帖（X 的 **Note Tweet**，服务端上限 **25,000** 字符）。插件走的是网页端同一个 GraphQL 操作
  `CreateNoteTweet`（`lib/note.mjs`），所以发出来是**一条正常的推文**，不是串推、不是文章。
- 阈值在配置里：`maxPostWeight`，默认 **25000**（Premium）。**非 Premium 账号请改成 280**，否则服务端回
  `186 Tweet needs to be a bit shorter`。

⚠️ 三个容易混的东西：

| 东西 | 是什么 | 怎么发 |
|:--|:--|:--|
| 普通推文 | ≤280 字符 | `x_post` → `CreateTweet` |
| **长帖 Note Tweet** | 一条推文，最长 25,000 字符，时间线里正常显示、可转发 | `x_post` → **`CreateNoteTweet`（本插件已接）** |
| **Articles（文章）** | 独立的长文页面（有标题、富文本、封面），不是推文 | X API v2 `POST /2/articles/draft` → `/publish`，需要 **OAuth 1.0a 或 OAuth 2.0 PKCE user token**（本插件的 cookie 登录不够） |

> 2026-11-06 实测：300 字符纯英文 / 545 字中文长帖都能发出去（`data.notetweet_create.tweet_results.result.rest_id`），
> 发完可正常删除。`twitter-cli` 0.8.5 只实现 `CreateTweet`，所以它自己永远卡在 280 —— 这也是之前「Premium 账号却发不了长文」的真正原因。

> 设置页里那块「环境自检」是插件内部版本（走 `x_status` / `x_whoami`，顺带起 MCP），
> 命令行这个 `selfcheck.mjs` 是独立零依赖版：DSH 没起来、插件没装好时也能先查环境。

### D. 凭据怎么来的（必做，否则搜不了）

从**已登录 x.com 的浏览器**里取两个 Cookie：`auth_token` 和 `ct0`，写进**当前用户的环境变量**（不是本仓库文件）：

```powershell
setx TWITTER_AUTH_TOKEN "<auth_token 的值>"
setx TWITTER_CT0 "<ct0 的值>"
```

- 写完**新开一个终端 / 重启 DSH** 才生效。
- 这两个值等同登录态：不要提交、不要贴群、不要写进 README/issue。
- 插件只把它们注入 `twitter.exe` 的子进程环境；自检只报"有/无"，不显示值。
- 失效（401/403）就重新从浏览器取一次。

### E. 可选：邮件通道

邮件投递用 `nodemailer`，**不装也能用**（会话投递 / 桌面通知不受影响）：

```powershell
cd <本仓库绝对路径>
npm install --omit=dev
```

## 依赖与一键安装

不用背命令：设置页里有「**依赖自检 / 一键安装**」区块，逐项显示缺什么，点一下装（全程写 `install.log`）。

### 依赖清单

| 依赖 | 必须？ | 说明 | 缺了怎么办 |
|---|---|---|---|
| Node.js ≥ 22 | 必须 | 插件和内置 MCP 都跑在 Node 上 | 升级 Node（nodejs.org，或 `winget upgrade OpenJS.NodeJS.LTS`） |
| twitter-cli 0.8.5 | 必须 | 所有读写都经它；只认 0.8.x 实测字段 | `pipx install twitter-cli`；没有 pipx 就 `python -m pip install --user twitter-cli` |
| 代理 | 必须 | 连不上 X 就没有数据（默认探测 7890） | 开代理软件，或设置页填 `proxy`；墙外可填 `direct` |
| 凭据 | 必须 | `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`（只注入子进程） | 按上面 D 节写用户环境变量 |
| nodemailer | 可选 | 只有邮件投递要它；不装不影响日报/会话投递 | 插件目录 `npm install --omit=dev`（或设置页一键装） |
| 插件家目录可写 | 必须 | 报告/日志/台账都写在 `$DSH_HOME/x-duty/` | 换可写目录（`DSH_HOME` / `X_DUTY_HOME`） |
| 插件文件完整 | 必须 | 缺文件 = 包不完整 | 重新安装插件 |

### 设置页一键安装

- 设置 → **刷 X** → 「**依赖自检 / 一键安装**」：逐项状态（Node / twitter-cli / nodemailer / 家目录 / 插件文件），缺项旁边有修复命令。
- 点「**一键安装缺失依赖**」：**只装依赖**（npm / pnpm / pipx），不调用 twitter-cli 业务命令、不碰账号。
  - 缺 nodemailer → 插件目录 `npm install --omit=dev`；失败回退 `pnpm add nodemailer`。
  - 缺 twitter-cli → `pipx install twitter-cli`；没有 pipx 就显示准确的 `pip install --user twitter-cli`（这条要你自己跑）。
  - 装完自动重新体检；输出写进 `$DSH_HOME/x-duty/install.log`（家目录不可写时退到插件目录）。
- 也可以让会话里的 AI 调 `x_setup`（`check` / `install` 两种模式），和自己点按钮等价。

### 等价命令（不想点页面时）

```powershell
cd <本仓库绝对路径>
node selfcheck.mjs                 # 看「④ 依赖」段；缺项会给修复命令
npm install --omit=dev             # 只装 nodemailer（邮件通道）
pipx install twitter-cli           # 没有 pipx：python -m pip install --user twitter-cli
```

`selfcheck.mjs` 退出码：**必须依赖缺 → 2**（Node 太旧 / twitter-cli 缺或太老 / 家目录不可写；环境或凭据问题也计入）；
**nodemailer 缺只提示、不算失败**（邮件通道不可用，其它照常）。要机器读加 `--json`，`checks.deps` 里逐项给 `{ok, detail, fix, cmd}`。

### 一键安装失败排查

| 症状 | 原因 / 怎么办 |
|---|---|
| npm 报代理 / 网络 | npm 走系统代理：设 `HTTPS_PROXY`（或 npm 的 proxy）后重试；也可先手动 `npm install --omit=dev` |
| npm EACCES / 只读目录 | 插件目录不可写：换一个可写位置重新安装，别在只读目录里装 |
| `pnpm` 不存在 | 一键装会自动回退；两条都失败就手动 `npm install --omit=dev` |
| 没有 pipx | 页面会给 `pip install --user twitter-cli`；装完确认 `twitter --version` |
| 装完 twitter 仍找不到 | 新开终端 / 重启 DSH（PATH 缓存）；或在设置页填 `twitterBin` 绝对路径 |
| 平台限制 | 一键安装只装依赖，不装 Node/Python 本身、不配代理/凭据（那两个自己填） |

## 设置页字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 每天自动跑的总开关（关掉只手动跑） |
| `runAt` | `09:30` | 每天几点跑（那一分钟内 DSH 活着就开跑） |
| `catchUp` | `true` | 到点时 DSH 没开 ⇒ 下次打开补跑这一轮 |
| `directions` | `AI / agent 与开源` 等三行 | **一行一个方向**，每个方向搜一次（写具体，别写"AI"） |
| `perDirection` | `20` | 每个方向抓多少条候选（5–50） |
| `deepRead` | `8` | 全部方向加起来精读（读全文+回复）几条（1–30） |
| `sort` | `general` | `general` 综合 / `latest` 最新 / `popular` 最热（映射到 CLI 的 `-t Top/Latest`：general/popular → Top，latest → Latest） |
| `readReplies` | `true` | 热点/争议的挑几条读回复区 |
| `reportLevel` | `full` | `full` 完整 / `brief` 薄版（五节仍保留） |
| `mirrorDir` | 空（不镜像） | 日报副本额外写到哪 |
| `workspace` | 空 | 指到某个目录就按那儿的 `AGENTS.md` 说话（留空 = 中性说话） |
| `headlessProfile` | `headless` | 跑一轮用的 dsh profile |
| `dshBin` | 空 | 自定义 `dsh` 可执行文件（空 = 用 PATH 里的） |
| `overlayMcp` | `true` | 起一轮时用 overlay 把内置 MCP 挂上 |
| `twitterBin` | 空 | twitter 可执行文件路径（空 = `X_TWITTER_BIN` → 常见安装位置 → PATH，顺序与 `selfcheck.mjs` 一致） |
| `proxy` | 空 | 代理 URL（空 = `X_PROXY` → 代理环境变量 → 7890/7892 → 系统代理；填 `direct` 直连） |
| `sessionTarget` | `off` | 会话投递：`off` / `latest`（最近活跃）/ `fixed`（指定的 `sessionId`） |
| `sessionId` | 空 | `sessionTarget=fixed` 时投给哪个会话 |
| `sessionSpeak` | `true` | 投递时让那个会话用几句人话说要点（会真跑一轮模型，有成本） |
| `deliverMail` | `false` | 邮件投递（SMTP，见下） |
| `smtpHost` / `smtpPort` | `smtp.qq.com` / `465` | SMTP 服务器 |
| `smtpSecure` | `true` | 465 一般 true；587 一般 false |
| `smtpUser` / `smtpFrom` | 空 | 发件账号 / 发件人（留空用账号） |
| `mailTo` | 空 | 收件人（多个用逗号） |
| `smtpPass` | 空 | 授权码；优先存 DSH 的 credentials（引用名 `X_SMTP_PASS`），拿不到才退明文并警告 |
| `deliverToast` | `false` | Windows 通知兜底 |
| `riskCooldownHours` | `24` | 触发限流后的冷却小时数（冷却期内手动跑也拒绝） |

> 写操作相关字段（`allowWrite` / `allowLike` / 额度…）单独一张表，见下面「写操作」一节。

常用邮箱的 SMTP：

| 邮箱 | 服务器 | 端口 | 授权码在哪拿 |
|---|---|---|---|
| QQ | `smtp.qq.com` | 465 | 设置 → 账户 → 开启 SMTP，拿「授权码」 |
| 163 | `smtp.163.com` | 465 | 设置 → POP3/SMTP → 开启 |
| Gmail | `smtp.gmail.com` | 465 | 两步验证 → 应用专用密码 |
| Outlook | `smtp-mail.outlook.com` | 587 | —— |

## 写操作（点赞 / 关注 / 回复 / 发帖 · 默认全关）

> **默认全关，fail-closed。** 总闸 `allowWrite=false` 时，下面四个单项开关一律无效。
> 打开写操作 = **用你的账号真的发出去**；读完这一节再决定。

### 开关与额度

| 字段 | 默认 | 说明 |
|---|---|---|
| `allowWrite` | `false` | **总闸**。关着时其余四项一律无效 |
| `allowLike` | `false` | 点赞 |
| `allowFollow` | `false` | 关注 |
| `allowReply` | `false` | 回复 |
| `allowPost` | `false` | 发帖（含引用转推） |
| `replyRequireConfirm` | `true` | 回复前必须 `confirm:true`（防模型顺手回） |
| `postRequireConfirm` | `true` | 发帖前必须 `confirm:true` |
| `maxLikesPerDay` | `20` | 每日点赞上限（0–200；0 = 不给点） |
| `maxFollowsPerDay` | `10` | 每日关注上限（0–100；0 = 不关注） |
| `maxRepliesPerDay` | `5` | 每日回复上限（0–50；0 = 不回复） |
| `maxPostsPerDay` | `3` | 每日发帖上限（0–20；0 = 不发帖） |
| `replyMinChars` | `15` | 回复正文最少字数（治"说得好"） |
| `replyAllowLinks` | `false` | 回复里是否允许放链接（冷启动期应关） |

**额度是上限，不是目标。** 没东西值得回就一条都不回；额度用满也不代表要接着做。

### 一道写操作要过 8 道闸

① 总闸 `allowWrite` → ② 单项开关 → ③ `confirm`（若 require）→ ④ 当日额度（按本地自然日）
→ ⑤ 去重（台账 / `write-seen.json`）→ ⑥ 内容闸门（仅回复/发帖：长度、语感、链接、字数）→ ⑦ 执行 → ⑧ 写台账。

任何一道不过，返回 `{ok:false, blocked:"<闸门>", reason:"中文原因"}`，**不会执行**。
`blocked` 的取值就是下面这些：

| `blocked` | 含义 |
|---|---|
| `allowWrite` | 总闸关着（最常见：默认状态） |
| `allowLike` / `allowFollow` / `allowReply` / `allowPost` | 对应的单项开关关着 |
| `confirm` | 要求确认但没传 `confirm:true` |
| `quota` | 当日额度用尽（按本地自然日，只数成功台账行） |
| `dedupe` | 台账/去重里已有：这条赞过 / 关注过 / 回过 / 今天发过同样开头 |
| `content` | 内容没过闸门（见下） |
| `execute` | 真去写了但失败（429 / 网络 / CLI 报错） |
| `input` / `args` | 入参不合法（id 不是纯数字、handle 超过 15 位、必填项为空；宿主与 MCP 各自的叫法） |

### 内容闸门（回复 / 发帖）

- **回复**：开头八股黑名单（说得好 / 学习了 / 支持 / 顶 / 感谢分享 / 受教了 / 牛 / 前排…）、纯表情、
  长度 < `replyMinChars`、`replyAllowLinks=false` 时含链接、与最近 20 条自己回复的 bigram 相似度 > 0.8、
  超过 280 加权字符 —— 一律拒。
- **发帖**：空正文 / 纯表情 / 超过 280 加权字符（URL 算 23、中文算 2）—— 拒。

被内容闸门拒的尝试会以 `blocked:content` 记进台账（方便回看"哪些话被拦了"）。

### 台账与去重

- 台账：`$DSH_HOME/x-duty/write-ledger.jsonl`，**只追加**，每行 `{ts,action,target,ok,tweetId,blocked,note}`；
  **不写凭据、不写正文全文**（回复只存前 40 字）。
- 去重：`$DSH_HOME/x-duty/write-seen.json` `{liked:{id:ts}, followed:{handle:ts}, replied:{id:ts}, posted:{id:ts}}`。
- 台账给人查"到底做了什么"；`x_write_status` 返回今日已用 / 上限 + 最后 5 条。

### 确认怎么做

- 回复 / 发帖（`*RequireConfirm=true`）只有在调用工具时带 `confirm:true` 才会执行。
- 在会话里要**明确**说："回复这条，用这句话：……"（AI 才该传 `confirm:true`）；含糊的"你看着办"不算授权。
- 也可以把 `replyRequireConfirm` / `postRequireConfirm` 关掉 —— **不推荐**，那等于把发帖权交给自动轮。

### 如果确实要开（默认的建议是就不开）

大多数人**不需要**开写操作：只要日报就保持全关。确实要开，用最小的一档起步：

1. 先只开总闸 + 点赞（额度 5/天；**不是让你每天点满 5 个**，没值得的就不点），观察一周：日报「本轮动手」是否诚实、有没有多余动作。
2. 再加关注（10/天，只给"连续两次看到他发同类好帖"的人）。
3. 回复保持 confirm、额度 5/天；发帖只在有实测回执的那天临时打开。
4. 任何时候觉得不对：**关总闸**。一个开关就停手。

## 语言风格：用你自己的 skill（推荐 elohia-double）

回复 / 发帖要"像你本人"，靠的是**你自己的写作 skill**，不是这个插件：

- 推荐在 DSH 的 skill 里装 / 启用 **`elohia-double`**（数字分身：学本人语气、写像本人的回复、回忆经历、检查文字像不像本人）。
- 本插件**不内置、不合并、不读取** elohia-double 的任何语料；它只提供闸门（长度 / 语感 / 链接 / 额度 / 确认）与台账，**不复制人格**。
- 没挂这类 skill 也能用：用中性、克制的表达；不要假装特定人设，不要编造"本人经历 / 本人数据"。
- 语气再像也不豁免红线：不编数字、不刷量、不批量回复。

## 工具（会话里的 AI 可以直接用）

| 工具 | 干什么 |
|---|---|
| `x_status` | 能不能跑：代理通不通、凭据有没有、CLI 版本、账号要不要登录（含写操作开关与今日用量） |
| `x_config` | 读/改设置（字段同上表） |
| `x_whoami` | 当前账号：handle / 昵称 / 粉丝 / 关注 / 推文 / 蓝V / 注册时间 |
| `x_search` | 关键词搜帖：作者 / 粉丝数 / 蓝V / 正文 / 赞转回 / 时间 / 链接 |
| `x_user` | 看一个人：简介 / 粉丝 / 关注 / 推文 / 蓝V / 链接 |
| `x_posts` | 一个人最近发了什么（含互动数据） |
| `x_tweet` | 读一条帖的全文 + 回复区（回复也带赞数） |
| `x_growth` | 账号数据：粉丝 / 关注 / 推文 / 蓝V / 近 10 条曝光 |
| `x_run` | 立刻跑一轮（不等 `runAt`） |
| `x_deliver` | 把日报送出去：`all` / `session` / `mail` / `toast` |
| `x_bind_session` | 把"当前会话"绑定成投递目标 |
| `x_like` | **写**：点赞一条（要总闸 + `allowLike`；额度/去重/已赞由台账把关） |
| `x_follow` | **写**：关注一个账号（要总闸 + `allowFollow`；已关注会被拒） |
| `x_reply` | **写**：回复一条（要总闸 + `allowReply`；再过 confirm / 长度 / 语感 / 链接 / 额度 / 去重） |
| `x_post` | **写**：发帖或引用转推（要总闸 + `allowPost`；confirm、≤280 加权、额度） |
| `x_write_status` | 写操作总览：总闸 + 四个单项开关 + 今日已用/上限 + 台账最后 5 条 |
| `x_setup` | 依赖体检 / 一键安装：`check` 看五项；`install` 只装 npm/pnpm/pipx 依赖并写 `install.log` |

- **读工具**（`x_status` / `x_whoami` / `x_search` / `x_user` / `x_posts` / `x_tweet` / `x_growth`）只读。
- **写工具**（`x_like` / `x_follow` / `x_reply` / `x_post`）**默认一律拒绝**：总闸/单项开关没开、没带 `confirm:true`、超额度、重复、内容不合格，任一不过就返回 `{ok:false, blocked, reason}`，不会执行。
- 没有**私信**、没有**转推**（引用转推走 `x_post` 的 `replyTo`）、没有`自动回关`。

## 一轮的输入与输出

**输入**（来自配置 + 当天日期）：

```
directions : AI / agent 与开源
             独立开发 / 出海收款
             A股工具与数据
perDirection: 20      deepRead: 8      sort: general
触发：每天 09:30 定时 / 设置页「现在跑一轮」/ 会话里让 AI 调 x_run
```

**输出**：

| 产物 | 位置 | 内容 |
|---|---|---|
| 日报 | `$DSH_HOME/x-duty/out/<日期>.md` | 五节：今日一句话 / 热点与事件 / 值得回的帖 / 账号数据 / 未决与风险 |
| 判重表 | `$DSH_HOME/x-duty/seen.md` | 进过日报的推文 ID 追加一行（下一轮不重复报） |
| 归档 | `$DSH_HOME/x-duty/digest/<年-月>.md` | 这一轮**看过**的每一条（挑中的和跳过的都算），给以后检索 |
| 日志 | `$DSH_HOME/x-duty/duty.log` | 这一轮的开始/结束/异常 |
| 写操作台账 | `$DSH_HOME/x-duty/write-ledger.jsonl` | 每次点赞/关注/回复/发帖一行（只追加；回复只存前 40 字） |
| 投递（可选） | 会话 / 邮件 / Windows 通知 | 摘要 + 日报路径（全文发邮件时作附件） |

写操作打开时，日报多一个 **`## 本轮动手`** 块：做了什么、对谁、为什么、结果（全关时只写一行"写操作：全关"）。

日报长这样（**格式示例，数字仅示意，实跑以工具返回为准**）：

```markdown
# X 日报 · 2026-10-31

> 一句话总结：agent 圈今天在吵"记忆系统到底要不要向量库"。
> 本轮：AI / agent 与开源（20 条）· 精读 8 · 跳过 3

## 今日一句话

两派人拿着各自的实测回执对喷，关键分歧不在检索质量，而在"写入前判重"要不要做。对正在写 agent 记忆层的人是直接可抄的素材。

## 热点与事件

### AI / agent 与开源

#### 主题：agent 记忆层开始从"检索"转向"写入策略"
- **信号**：3 个不同作者的帖子都在讲"写入前判重"，其中两条赞过 300
- **在说什么**：……
- **代表帖**：[……](https://x.com/i/status/1234567890123456789) · @someone · 赞 412
- **我的判断**：值得跟，一周内会有可复现的开源实现

#### 事件：某模型发布当天被质疑 benchmark 可比性
- **经过**：……
- **分歧点**：……
- **代表帖**：[……](https://x.com/i/status/9876543210987654321) · @someone · 赞 3.4k

## 值得回的帖

### 1234567890123456789
- [作者原话摘一句](https://x.com/i/status/1234567890123456789) · @someone · 赞 320 · 回 12
- **建议角度**：我们这边的写入判重用的是 ……，实测把重复率从 x% 降到 y%
- **为什么**：回复只有 12 条且作者在逐条回，话题正热

## 账号数据

- 粉丝：6（较上一份日报 +2）· 关注：70 · 推文：42 · 蓝V：是
- 近 10 条：均曝光 1200 · 最高曝光 4800（来源 `x_growth`）

## 未决与风险

- 限流/异常：无
- 代理：http://127.0.0.1:7890，本轮稳定
- 口径未核实：曝光口径与创作者门槛未官方核实

## 本轮动手（写操作）

- 回复 [1234567890123456789](https://x.com/i/status/1234567890123456789) · @someone：补一条"写入判重把重复率从 18% 降到 3%"的实测 → 已发
- 点赞 9876543210987654321：全文读完，值得再看
- 关注 @someone：连续两次看到他发同类的记忆层实测
- 发帖：[……](https://x.com/i/status/1122334455667788990) · 今天的判重实测回执
- 本轮没动手：无

（写操作全关时这一块只写一行：`- 写操作：全关（本轮只读）`）

## 本轮口径

- 方向：AI / agent 与开源（20 条）· 独立开发 / 出海收款（18 条）· A股工具与数据（12 条）
- 深读：8 条（值得 5 / 一般 2 / 跳过 1）
- 跳过原因：1 条纯广告
- 写操作：已做 4 条（点赞 1 / 关注 1 / 回复 1 / 发帖 1）
- 失败/限流：无
```

> 同一天第二次跑会**追加**到同一份文件的末尾，不覆盖上一轮 —— 「值得回的帖」的 `### 推文 ID` 标题行照样重写，宿主一起数。

## 目录

```
$DSH_HOME/x-duty/
├── config.json          设置页写的就是它（**不含 token、不含代理密码**）
├── state.json           今天跑没跑 / 上次投递结果
├── login.json           上次抓到账号时留下的 handle（不是登录态）
├── duty.md              值班章程（可改；新版会另存 duty.md.new，不覆盖你改过的）
├── out/<日期>.md         日报
├── digest/<年-月>.md      归档：看过的每一条（一行一条）
├── seen.md              判重表
├── headless-overlay.yml 跑一轮时临时生成的 overlay（有才出现）
├── duty.log             跑一轮的日志
├── install.log          依赖安装日志（点「一键安装」才有）
├── write-ledger.jsonl   写操作台账（只追加；有动手才有）
├── write-seen.json      写操作去重（赞过/关注过/回过/发过；有动手才有）
├── risk.json            触发限流后的冷却记录（有才出现）
└── risk-signals.jsonl   抓取端留下的限流/风控信号（有才出现）
```

> 配置与运行数据都在家目录，**不写进插件包目录**（包目录可能只读、升级会被覆盖）。
> 不再有浏览器 profile —— 现在不驱动浏览器。

## 排错（症状 → 原因）

| 症状 | 原因 / 怎么办 |
|---|---|
| `node selfcheck.mjs` 报「twitter 没找到」 | 设 `X_TWITTER_BIN`，或在设置页填 `twitterBin`，或把 twitter 放进 PATH；也可在设置页「依赖自检」点一键安装 |
| 自检「④ 依赖」有 ✗（或缺 nodemailer 的 •） | 按缺项旁边的修复命令；或在设置页「依赖自检 / 一键安装」直接装 |
| 一键安装失败 | 看 `install.log` 尾部（npm/pnpm/pipx 的原始输出都在）；再对照上面「一键安装失败排查」 |
| 缺 nodemailer | 只影响邮件投递：设置页一键装，或 `npm install --omit=dev`；不装也能用 |
| 自检报「没有可用代理」 | 开代理软件让 7890 通；或设 `X_PROXY`；或设置页填 `proxy`。7892 是回退，可能已死。机器本来就在墙外就填 `direct` |
| 自检报「凭据没有」 | 按上面 D 节写 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`，新开终端/重启 DSH |
| 认证 401 / 403 | Cookie 失效或轮换了，重新从浏览器取两个值 |
| 搜到 0 条 | 查询太窄 / 被限流 / 代理不稳。先 `x_status` 复核，别直接写"今天没内容" |
| 429 / 限流 | 降量、隔天再来；冷却期内手动 `x_run` 也会被拒绝 |
| 写操作返回 `blocked:allowWrite` | 总闸没开：设置 → 刷 X → 写操作 → 打开「总闸」 |
| 写操作返回 `blocked:allowLike` / `allowFollow` / `allowReply` / `allowPost` | 对应单项开关没开 |
| 写操作返回 `blocked:confirm` | 调用没带 `confirm:true`（或没人批准这次动作）—— 别改配置绕，先确认 |
| 写操作返回 `blocked:quota` | 当日额度用尽（按本地自然日）：明天再算；不要把同一动作拆多次绕额度 |
| 写操作返回 `blocked:dedupe` | 台账/去重里已有：这条已经赞过/关注过/回复过，或今天发过同样开头 |
| 写操作返回 `blocked:content` | 回复/发帖没过内容闸门（八股/太短/链接/太像自己/超 280）：改文案，别关闸门 |
| 写操作返回 `blocked:execute` | 真去写了但失败（常见 429）：停手，不连着重试 |
| 写操作返回 `blocked:input` / `args` | 入参不合法（id 不是纯数字、handle 格式不对、必填项为空）—— 先修参数 |
| 写操作超时 / 失败 | 停手，不连着重试（避免重复发）；看台账和 `duty.log` |
| 想查到底做了什么 | `write-ledger.jsonl`；或让 AI 调 `x_write_status` 看台账最后 5 条 |
| 报告里全是「未取到」 | 多半是通道或字段变了，看 `duty.log` 尾部 + 跑一次 `selfcheck.mjs` |
| 设置页里没有「刷 X」 | 没重启 DSH（bundle 层要重启才组装） |
| 设置 → 刷 X 页面是空的 | 插件没激活；看 DSH 启动日志里的插件报错 |
| 桌面版 `dsh plugin --profile desktop add` 被拒 | 设计如此，桌面版从图形入口装（见 A 节） |

## 已知风险（诚实说）

1. **X 没有给个人开发者开放的免费读取 API**。本插件用你的登录态经 twitter-cli 走 X 的接口 —— 账号有被限流/风控的可能。
   只读 + 每天一轮 + 保守量级（`perDirection` 20、`deepRead` 8）能把风险压低，**但不是零**。
2. **接口与 CLI 会变**。0.8.5 实测可用；升级/下降都可能改字段，真对不上时自检和 `duty.log` 会先暴露。
3. **数字口径**：曝光、蓝V 粉这类字段取决于接口返回；取不到就写「未取到」，不拿 0 顶。
4. **代理是硬门槛**：连不上 X 就什么都做不了，这轮只会产出失败日报。
5. **登录态等同密码**：`TWITTER_AUTH_TOKEN` / `TWITTER_CT0` 泄露等于账号被接管。别提交、别外发、别写进日报。
6. **写操作不可撤回**：回复 / 发帖 / 关注 / 点赞一旦发出，插件**不会**自动撤销；X 侧的限流、社区规则、封号风险由操作者承担。
   默认全关；长期建议保持全关，确实需要才开最小额度，回复/发帖保持人工确认。
7. **合规不是靠额度**：额度 / 闸门只降低误操作和刷量概率，**不构成对平台规则的豁免**。批量自动回复、刷量在任何额度下都禁止。

## 红线

- **默认只读，写操作是例外**：只有总闸 + 单项开关都开、且过确认 / 额度 / 去重 / 内容闸门才会写；开关没开就一条都不做。没有私信能力。
- **不刷量**：不批量自动回复、不批量关注/点赞、不互赞互关、不自动回关、不为"用满额度"而动手。
  X 的自动化规则与创作者协议禁止这些；**额度只是"少做"，不是合规挡箭牌**。
- **不自动回复**：回复必须是人明确批准的那几条（`confirm`），不做"每条都回一句"。
- **不自动发帖**：发帖只在有实测回执、且人确认后发；AI 自动发帖 / 定时灌水不做。
- **不绕闸门**：被 `blocked` 拒绝后不改参数重试、不拆单绕额度、不直接调 `twitter.exe` 写命令；失败不连着重试（避免重复发）。
- **不编数字**：日报里每个数字、每条链接都必须来自本轮工具返回；没取到就写「未取到」。

## 参考

- 插件骨架（host 半端 + 内置 MCP + headless 值班轮 + 设置页 + 章程升级记账）来自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）。
