# CHANGELOG

## 0.3.2 · 2026-11-06

### 新增：文章里的图片 / 封面 / 代码块 / 内嵌帖子

- `lib/media.mjs` + `lib/upload_helper.py`：媒体上传（INIT/APPEND/FINALIZE/STATUS）。
  Node 的 TLS 过不了 upload.x.com 的 Cloudflare，改由 twitter-cli 同 venv 的 curl_cffi（`impersonate=chrome`）上传；
  `CurlMime` 传 multipart，FINALIZE 接受 200/201/202。
- `lib/article.mjs`：`mdToContentState` 支持 MEDIA / MARKDOWN（代码块）/ TWEET / DIVIDER 实体；
  `setCoverMedia`（`ArticleEntityUpdateCoverMedia`）；`publishArticleFlow` 串起「传图 → 建草稿 → 设封面 → 发布」。
- `x_article` 增加 `images` / `cover` 参数；返回 `images` 张数与 `cover` media_id。

### 修

- `publishArticle` 现在检查 GraphQL `errors`：`code 344` 映射成人话（当日发送额度用尽，草稿保留）。
- `lib/http.mjs`：抽出的通用 HTTPS 客户端（代理 CONNECT + chunked/content-length 分帧），空白 POST 现在也带 `Content-Length: 0`。

## 0.3.1 · 2026-11-06

### 新增：文章（X Article）

- `lib/article.mjs`：markdown → Draft.js `content_state`；`ArticleEntityDraftCreate` 建草稿、`ArticleEntityPublish` 发布、
  `ArticleEntityDelete` 清理；queryId 轮换自动换备用。
- `x_article` 工具（宿主编排）：`{ title, markdown, publish?, confirm? }`；`publish:false` 只建草稿。
- 闸门：action `article` 复用 `allowPost` + `maxPostsPerDay`，内容闸门只校验标题（正文由 content_state 承载）。

### 改

- `lib/note.mjs` 抽出通用 `graphqlPost(op, qid, payload, opts)`，长帖与文章共用同一套 cookie 传输层。

## 0.3.0 · 2026-11-06

### 新增：长帖（>280 加权）

- `lib/note.mjs`：走 X 网页端的 `CreateNoteTweet`（`_eeuQKX1-VyRP_ROM-GN7g`），支持到 25,000 字符。
  自实现 CONNECT 代理 + TLS + HTTP/1.1 分帧（content-length / chunked），零依赖。
- `lib/xcli.mjs` 的 `postTweet` 自动分流：≤280 走 twitter-cli，>280 走长帖通道。
- `maxPostWeight` 默认改为 **25000**（非 Premium 请改回 280）。
- 修：之前 >280 会撞 `186 Tweet needs to be a bit shorter` —— 根因是 twitter-cli 只实现 `CreateTweet`。

### 改：发帖条件（真人化，不是批量）

- `prompts/duty.md`：每轮最多 1 条原创；允许「本轮实测回执」**或**「今天读到的一件事 + 自己的一句判断」。

## 0.2.1
（依赖自检 / 一键安装 / 语言风格推荐）
