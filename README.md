# dsh-x-scroll（刷 X）

每天替你刷一轮 X（Twitter）：**按你填的方向搜 → 读原帖和回复区 → 提炼当天真正发生的事 → 写一份日报**，
顺手记一下账号涨没涨。日报写到 `$DSH_HOME/x-duty/out/<日期>.md`。

> **只读。** 这个插件**没有**点赞 / 转推 / 引用 / 回复 / 关注 / 私信 / 发帖的能力 —— 工具层就没有，也不打算加。

## 它干三件事

1. **按方向刷 X 读帖**：你填的每个方向搜一轮，按互动数据分层，挑出值得精读的读全文 + 回复区。
2. **写日报**：固定五节（今日一句话 / 热点与事件 / 值得回的帖 / 账号数据 / 未决与风险），每条带链接和"为什么值得看"。
3. **涨粉数据**：粉丝、关注、推文、蓝V、近 10 条曝光（来自 `x_growth`），以及和上一份日报的差值。

## 它怎么工作

```
设置页（client.js）──/api/x-duty/*──▶ host 插件（index.js）
                                        │  ·每天 09:30 定时器（可改）
                                        │  ·注册 x_* 工具（给会话里的 AI 用）
                                        │  ·到点起一轮：dsh --profile headless --patch <overlay> <prompt>
                                        ▼
                          server/mcp_server.mjs（内置 MCP，stdio JSON-RPC）
                                        │  twitter-cli（twitter.exe 0.8.5，只读子命令）
                                        ▼
                                     X（用你的登录态；凭据只注入子进程环境）
```

- **取数走 twitter-cli**：`twitter status/whoami/search/user/user-posts/tweet --json`，拿结构化 JSON，不抓页面 DOM。
- **认证**：从进程环境或 `HKCU\Environment` 读 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`，**只注入子进程 env，不打印、不落盘**。
- **代理**：设置页 `proxy` → `X_PROXY` → `TWITTER_PROXY` / `HTTPS_PROXY` 等 → 探测 `127.0.0.1:7890`（活）→ `7892`（回退）→ 系统代理设置；全不通就返回失败，不硬跑。显式指定的代理连不上会**直接报错**（不偷偷换别的）；机器本来就在墙外可填 `direct`（或设 `X_DIRECT=1`）直连。
- **凭据/代理任一不通 ⇒ 这一轮不跑**，只写一份"失败日报"说明卡在哪，不编造内容。

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

零依赖，查三样东西并给三段人看的输出：① twitter 二进制 / CLI 版本 / 代理端口 ② 凭据有没有（不显示值）
③ 真跑一次 `twitter status --json` 看账号。**退出码 0 = 全通；2 = 有缺**。要机器读就加 `--json`。

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

## 设置页字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 每天自动跑的总开关（关掉只手动跑） |
| `runAt` | `09:30` | 每天几点跑（那一分钟内 DSH 活着就开跑） |
| `catchUp` | `true` | 到点时 DSH 没开 ⇒ 下次打开补跑这一轮 |
| `directions` | `AI / agent 与开源` 等三行 | **一行一个方向**，每个方向搜一次（写具体，别写"AI"） |
| `perDirection` | `20` | 每个方向抓多少条候选（5–50） |
| `deepRead` | `8` | 全部方向加起来精读（读全文+回复）几条（1–30） |
| `sort` | `general` | `general` 综合 / `latest` 最新 / `popular` 最热（映射到 CLI 的 `--sort`） |
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

常用邮箱的 SMTP：

| 邮箱 | 服务器 | 端口 | 授权码在哪拿 |
|---|---|---|---|
| QQ | `smtp.qq.com` | 465 | 设置 → 账户 → 开启 SMTP，拿「授权码」 |
| 163 | `smtp.163.com` | 465 | 设置 → POP3/SMTP → 开启 |
| Gmail | `smtp.gmail.com` | 465 | 两步验证 → 应用专用密码 |
| Outlook | `smtp-mail.outlook.com` | 587 | —— |

## 工具（会话里的 AI 可以直接用）

| 工具 | 干什么 |
|---|---|
| `x_status` | 能不能跑：代理通不通、凭据有没有、CLI 版本、账号要不要登录 |
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

所有 `x_*` 都是**只读**：没有发帖、点赞、转推、回复、关注、私信。

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
| 投递（可选） | 会话 / 邮件 / Windows 通知 | 摘要 + 日报路径（全文发邮件时作附件） |

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

## 本轮口径

- 方向：AI / agent 与开源（20 条）· 独立开发 / 出海收款（18 条）· A股工具与数据（12 条）
- 深读：8 条（值得 5 / 一般 2 / 跳过 1）
- 跳过原因：1 条纯广告
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
├── risk.json            触发限流后的冷却记录（有才出现）
└── risk-signals.jsonl   抓取端留下的限流/风控信号（有才出现）
```

> 配置与运行数据都在家目录，**不写进插件包目录**（包目录可能只读、升级会被覆盖）。
> 不再有浏览器 profile —— 现在不驱动浏览器。

## 排错（症状 → 原因）

| 症状 | 原因 / 怎么办 |
|---|---|
| `node selfcheck.mjs` 报「twitter 没找到」 | 设 `X_TWITTER_BIN`，或在设置页填 `twitterBin`，或把 twitter 放进 PATH |
| 自检报「没有可用代理」 | 开代理软件让 7890 通；或设 `X_PROXY`；或设置页填 `proxy`。7892 是回退，可能已死。机器本来就在墙外就填 `direct` |
| 自检报「凭据没有」 | 按上面 D 节写 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`，新开终端/重启 DSH |
| 认证 401 / 403 | Cookie 失效或轮换了，重新从浏览器取两个值 |
| 搜到 0 条 | 查询太窄 / 被限流 / 代理不稳。先 `x_status` 复核，别直接写"今天没内容" |
| 429 / 限流 | 降量、隔天再来；冷却期内手动 `x_run` 也会被拒绝 |
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

## 红线

- **只读**：不点赞、不转推、不引用、不回复、不关注、不私信、不发帖。工具层没有这些能力，也别绕去直连 CLI 的写命令。
- **不刷量**：不做批量关注/点赞、互关互赞、自动回复、养号脚本。每天一轮，量级别往上调。
- **不自动回复**：日报只给「值得回的帖 + 建议角度」，回复由人手动发、手动改。
- **不自动发帖**：按 X 的自动化规则与创作者协议，AI 自动发帖 / 自动互动不做 —— 本插件也不提供发布能力，发布永远由人做。
- **不编数字**：日报里每个数字、每条链接都必须来自本轮工具返回；没取到就写「未取到」。

## 参考

- 插件骨架（host 半端 + 内置 MCP + headless 值班轮 + 设置页 + 章程升级记账）来自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）。
