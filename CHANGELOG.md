# 变更记录

> 版本号跟 `package.json` 的 `version`。配置字段只加不改：老 `config.json` 不需要迁移，缺的字段走默认值。
> 写操作相关能力**默认全关**，升级本身不会让插件开始写。

## 0.2.1 — 2026-10-31

### 新增：依赖自检与一键安装

- 新增 `lib/deps.mjs`：逐项体检 Node.js ≥ 22 / twitter-cli / nodemailer / 插件家目录可写 / 插件文件完整，
  每项返回 `{ok, detail, fix, cmd}`（为什么 + 怎么修 + 可抄的命令）。
- 一键安装：缺 nodemailer → 插件目录 `npm install --omit=dev`（失败回退 `pnpm add nodemailer`）；
  缺 twitter-cli → `pipx install twitter-cli`（没有 pipx 就给准确的 `pip install --user twitter-cli`）。
  幂等：已满足的项跳过，重复点不会重复装。
- 安装边界：**只装依赖**（npm / pnpm / pipx），不调用 twitter-cli 业务命令、不碰账号；
  全程写 `$DSH_HOME/x-duty/install.log`（家目录不可写时退到插件目录），设置页能看输出尾部。
- 新增宿主工具 `x_setup`（`check` / `install` 两种模式）、路由 `GET /api/x-duty/deps` 与
  `POST /api/x-duty/install`；设置页新增「依赖自检 / 一键安装」区块（逐项状态 + 按钮 + 安装输出）。

### selfcheck 升级

- 新增「④ 依赖」段：node / twitter-cli / nodemailer / 家目录，缺项附修复命令。
- 退出码语义统一：**必须依赖缺 → 2**；**nodemailer 缺只提示**（只影响邮件通道，不算失败）。
- JSON 增加 `checks.deps`（逐项 `{ok, detail, fix, cmd}`）。

### 语言风格：推荐自己的 skill，插件不内置

- README / AGENTS / duty 都写明：回复/发帖的"像你本人"由使用者自己的写作 skill 提供，
  推荐装 **`elohia-double`**（数字分身，学本人语气、写像本人的回复）。
- 插件**不内置、不合并、不读取**它的任何语料；插件只提供闸门（长度 / 语感 / 链接 / 额度 / 确认）与台账，
  **不复制人格**。没挂这类 skill 也能用，用中性克制的表达即可。

### 兼容性

- 配置字段无变化（0.2.0 的写操作配置照旧）；升级不会改变任何开关默认值。
- 一键安装是可选路径：不点也能按 README 的命令手动装。

### 已知限制

- 一键安装不装 Node/Python 本体，也不配代理/凭据（这两个要自己填）。
- 机器上没有 pipx 时，twitter-cli 只能给 `pip install --user twitter-cli`，需要手动跑一次。
- 语气学习不在插件内：插件不会读取、复制或缓存任何 skill 的语料。

## 0.2.0 — 2026-10-31

### 新增：写操作（点赞 / 关注 / 回复 / 发帖）

- 新增五个工具：`x_like` / `x_follow` / `x_reply` / `x_post` / `x_write_status`（前四个**默认拒绝**）。
- 配置新增：总闸 `allowWrite` + 四项开关 `allowLike` / `allowFollow` / `allowReply` / `allowPost`；
  确认开关 `replyRequireConfirm` / `postRequireConfirm`；每日额度 `maxLikesPerDay` / `maxFollowsPerDay` /
  `maxRepliesPerDay` / `maxPostsPerDay`；回复闸门 `replyMinChars` / `replyAllowLinks`。
- 设置页新增「写操作」区块：一个总闸 + 四个单项 + 两个确认 + 四个额度 + 回复字数/链接；总闸关时整块置灰。
- `x_status` 返回值新增 `write` 块（四个开关 + 今日已用/上限），日报和会话能看到"今天能不能动手、动了几次"。
- `selfcheck.mjs` 环境段新增一行「写操作：全关 / 已开 N 项」（只报状态，不影响退出码）。

### 安全闸门（fail-closed）

- 每笔写操作必须依次过 8 道闸：总闸 `allowWrite` → 单项开关 → `confirm`（若 require）→ 当日额度 →
  去重 → 内容闸门（回复/发帖：长度、语感、链接、字数）→ 执行 → 写台账。
- 任何一道不过：返回 `{ok:false, blocked:"<闸门>", reason:"中文原因"}`，**不执行**。
- 回复语感闸门：开头八股黑名单（说得好/学习了/支持/顶/感谢分享/受教了…）、纯表情、
  与最近 20 条自己回复的 bigram 相似度 > 0.8、长度不足、该关链接时带链接 —— 一律拒。
- 去重：`write-seen.json` 记住赞过/关注过/回过/发过的目标，重复直接拒。
- 台账：`write-ledger.jsonl`（只追加）记录 `{ts,action,target,ok,tweetId,blocked,note}`；
  不写凭据、不写正文全文（回复只存前 40 字）。

### 章程与文档

- `prompts/duty.md` 新增「写操作（只有开关打开时才做）」节，并加「本轮动手」记录块；
  明确"宁可少做，不许刷量"、被 `blocked` 就停、失败不连着重试。
- README 新增「写操作」开关表、8 道闸、语感规则、台账位置、确认方式、建议开启顺序与红线。
- AGENTS 新增「写操作：什么时候可以动手、怎么收口」；selfcheck 输出与 README 自检说明同步。

### 红线（写进了章程与文档）

- 默认只读；开关没开就一条都不做。
- **不批量自动回复、不刷量、不互赞互关、不自动回关**；X 的自动化规则与创作者协议禁止这些。
- 额度是上限不是目标；不为了用满额度动手。
- 不绕闸门：被拒不改参数重试、不拆单绕额度、不直接调 `twitter.exe` 写命令。
- 没有私信能力，也不加。

### 兼容性

- 新增配置字段都有默认值（写操作全关），老 `config.json` 无需迁移。
- 读工具的行为与 0.1.0 一致；写工具在开关全关时返回 `blocked`，不会触网。

### 已知限制

- 写操作一旦发出**不可撤回**；限流、社区规则与封号风险由操作者承担。
- 引用转推走 `x_post` 的 `replyTo`；没有独立的转推/私信工具。
- 额度按台账统计；台账被手动删除会失去当日用量与去重依据（不建议）。

## 0.1.0 — 2026-10-31

- 首个 X 版本：按方向刷 X → 读原帖与回复区 → 写五节日报 → 记涨粉数据（`x_growth`）。
- 内置 MCP（stdio JSON-RPC）转发 twitter-cli 只读子命令；凭据只注入子进程环境，不打印、不落盘。
- 代理自动探测（配置 → 环境变量 → 7890/7892 → 系统代理），全不通不硬跑。
- 五节日报 + `seen.md` 判重 + `digest/` 归档 + 会话/邮件/Windows 通知投递。
- `selfcheck.mjs` 零依赖环境自检（二进制 / 版本 / 代理 / 凭据 / whoami）。
