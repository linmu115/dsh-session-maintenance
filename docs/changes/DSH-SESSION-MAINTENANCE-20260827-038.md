# 官方 rc.2 紧凑流事件读取修正

**日期：** 2026-08-27  
**范围：** DSH JSONL/Zstd 读取与归一化

## 发现

正式扫描在原生 DSH 会话中遇到 `text-chunks`、`reasoning-chunks` 和 `tool-call-chunks`。这些官方紧凑流事件使用 `seq0/time0` 表示一批连续 token，而不是普通事件的 `seq/time`。旧 decoder 因而在首个紧凑事件处报 `Malformed DSH event`。同一工具调用的多个 chunk 还会复用 `data.id`，不能把该 ID 单独当作事件唯一键。

## 修正

- decoder 接受两种明确事件封装：普通 `seq/time` 与紧凑 `seq0/time0`；其他形状继续拒绝。
- 紧凑事件按 `seq0 + type` 形成稳定且唯一的 source event ID，不把复用的工具调用 ID误当事件 ID。
- 紧凑流记录作为来源 metadata 完整保留；最终 `assistant/message`、`tool/call` 和 `tool/result` 仍按既有规则归一化，不把 token chunk 伪造成额外聊天消息。

## 验证

- codec、DSH adapter 与 Phase 1 接受测试：3 files / 9 tests 通过。
- 对正式 DSH home 的只读遍历：224 个会话全部可列出、读取和归一化，失败数 0。
- 受影响包 typecheck 与 `git diff --check` 通过。

旧同步插件在本次修正期间仍保留；正式扫描成功前不会退出。
