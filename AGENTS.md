# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-x-scroll`（中文名「**刷 X**」）：每天替用户刷一轮 X —— 按他填的方向搜帖、读原文和回复区，
提炼当天真正发生的事，写一份五节日报，并记账号涨粉数据。**只读**：没有发帖/点赞/转推/回复/关注/私信的代码路径。

排错前先读仓库根的 **CONTRACT.md**（唯一口径）；本文件只讲"怎么用、别踩什么"，两者冲突时以 CONTRACT 为准。

## 一句话流程

`x_status` 探通道 → 每方向 `x_search` → 挑精读 `x_tweet`（带回复区）→ 写 `out/<日期>.md` 五节 → 更新 `seen.md` → （可选）`x_deliver`。

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

## 日报在哪

- 日报：`$DSH_HOME/x-duty/out/<YYYY-MM-DD>.md`（`$DSH_HOME` 默认 `~/.dsh`；可用 `X_DUTY_HOME` 覆盖整个家目录）
- 配了 `mirrorDir` 会再复制一份到那里
- 判重表：`$DSH_HOME/x-duty/seen.md`；日志：`$DSH_HOME/x-duty/duty.log`
- 配置：`$DSH_HOME/x-duty/config.json`（**不含 token；SMTP 授权码优先在 DSH credentials 的 `X_SMTP_PASS`**）

## 装 / 排查顺序（桌面版实测）

1. 侧栏 **插件 → 添加插件**，填本仓库**绝对路径**，安装。
   桌面版 profile 由 Electron 独占：`dsh plugin --profile desktop add ...` 会被拒（`profile "desktop" is managed exclusively by the Electron application`）。命令行 profile 才用 `dsh plugin --profile <name> add "link:<路径>"`。
2. **重启 DSH**（bundle 层重启才组装）。
3. `cd <仓库> && node selfcheck.mjs` —— 三段全 ✓ 再继续（找二进制/代理的顺序和插件一致；`--json` 给机器）；看不懂哪段就照 README「排错」对。
4. 设置 → **刷 X** → 等「**环境自检**」跑完（点「**重新自检**」可重跑）→「现在跑一轮」；进度看 `duty.log`。
5. 要邮件才 `npm install --omit=dev`（只装 nodemailer；不装不影响别的通道）。

## 硬约束（都是实测撞出来的，别改回去）

- **凭据只注入子进程环境**：从 `process.env` 或 `HKCU\Environment` 读 `TWITTER_AUTH_TOKEN` / `TWITTER_CT0`，
  **绝不打印、绝不写文件、绝不进日志/日报**。自检只报"有/无"和来源。
- **代理顺序**（与 `lib/xcli.mjs` 一致）：配置 `proxy` → `X_PROXY` → `TWITTER_PROXY` / `HTTPS_PROXY` 等 → 探测 `127.0.0.1:7890` → `7892`（**已死，只作回退**）→ 系统代理。
  全不通就返回失败对象，**不要抛异常**，更不要硬跑一轮。机器本来就在墙外可填 `direct`（或 `X_DIRECT=1`）。
- **twitter-cli 定位顺序**（`lib/xcli.mjs` 与 `selfcheck.mjs` 一致）：配置 `twitterBin` → `X_TWITTER_BIN` → 常见安装位置（`~/.local/bin`、pipx、Python Scripts）→ PATH；显式指定的路径不可用要**直接报错**，不偷偷换。
- **twitter-cli 输出形状**：`{"ok":true,"schema_version":"1","data":{...}}`（0.8.5 实测）。
  只读子命令：`status` / `whoami` / `search` / `user` / `user-posts` / `tweet` / `followers` / `following`。
- **只读**：不要调 `post` / `reply` / `like` / `retweet` / `follow` / `bookmark` 这些写子命令，也不要"帮用户顺手点个赞"。
  要加写能力先问用户，并对照 X 的自动化规则与创作者协议。
- **没通道不跑**：`x_status` / `x_whoami` 失败 ⇒ 这一轮写失败日报（五节照留，说明卡在哪 + 探测结果），不编内容。
- **429 / 限流**：停手，不重试第二次；`riskCooldownHours` 冷却期内连手动 `x_run` 也拒绝，别绕。
- **报告计数口径**：宿主只数「值得回的帖」里 `### <纯数字推文 ID>` 的标题行。改日报格式要同步改 index.js 的计数逻辑；
  「热点与事件」里的标题别写成纯数字。
- **链接只能来自本轮工具返回**：用工具给的 `url`，或由 `id` 拼 `https://x.com/i/status/<id>`；别拿 handle 猜。
- **章程升级走记账制**（`charter.sha256`）：用户改过 `duty.md` 就一个字不动，新版另存 `duty.md.new`。
- **家目录不写插件目录**：配置/报告/日志全在 `$DSH_HOME/x-duty/`；装进 node_modules 后包目录可能只读、升级会被覆盖。
- **定时器 / 子进程回调里绝不让异常外冒**：未捕获异常会杀掉整个 DSH 宿主。

## 这个仓库现在有什么

- `index.js` —— host 半端：`x_*` 工具注册 + 每天定时器 + `/api/x-duty/*` + 配置 + 起一轮 + 镜像 + 投递
- `client.js` —— 设置页（侧栏「刷 X」）
- `server/mcp_server.mjs` —— 内置 MCP（stdio JSON-RPC）：把 `x_*` 转发给 twitter-cli
- `lib/` —— `xcli.mjs`（twitter-cli 封装：定位二进制、注入凭据、代理探测、跑只读子命令）/ `state.mjs`（家目录、章程升级、日期）/ `mcp.mjs`（stdio JSON-RPC 客户端）/ `hostdeps.mjs`（从宿主树取 `defineTool`）/ `deliver.mjs`（会话投递 + 邮件 + 通知 + 摘要抽取）
- `prompts/duty.md` —— 一轮要做的事 + 五节日报格式（用户可改）
- `selfcheck.mjs` —— 零依赖环境自检（二进制 / 版本 / 代理 / 凭据 / whoami；退出码 0 或 2）

## 已知残留（改造中，别按旧注释猜）

- 骨架从上一代插件抄来（见文末「出处」），个别文件（如 `lib/state.mjs` 的路径注释、`lib/deliver.mjs` 的日报摘要正则）可能还留着旧文案/旧标题匹配。
  行为以 CONTRACT 与代码实际为准；发现不一致先记下来，别照着注释改方向。
- **`lib/deliver.mjs` 里还有上一代品牌的残留**（不在本轮改造范围）：桌面通知兜底标题、会话消息 id 前缀、
  摘要抽取正则都还是旧文案/旧标题匹配。投递时看到旧品牌痕迹，就改这个文件（属于另一块写范围），
  别在文档里伪造它已经改好。

## 出处

仿照 dsh-xhs-scroll（小红书版）改造；更上游骨架来自 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)（MIT）。
