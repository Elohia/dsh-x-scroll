# CHANGELOG

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
