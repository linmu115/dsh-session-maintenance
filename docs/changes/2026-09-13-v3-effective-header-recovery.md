# V3 持久原生会话的工作目录恢复一致性

日期：2026-09-13

## 问题

原会话工作目录不存在时，原生会话准备过程会选择受管理的有效工作目录，并将有效 header 写入原生文件和该 run 的持久会话 catalog。投影正文仍然保留原版本的 header。此前恢复流程只从投影正文读取 header，导致它与已准备好的原生文件不一致；即使没有新增尾部，严格 header 校验也会拒绝恢复。

## 修改

- Adapter 恢复接口接收可选的已持久登记的原生会话 metadata。V3 Adapter 核对逻辑会话、实例、profile、继承事件数量，并仅允许 header 的 `cwd` 与原投影不同；其它 header 和 lineage 字段继续严格一致，工作目录必须为绝对路径。
- 原生空间恢复从当前 run 的持久 catalog 提供 metadata，缺少已登记会话记录时直接拒绝恢复。
- 先由原有 V3 尾部读取流程校验实际原生 header 和完整前缀；全部校验成功后，才将有效 header 写入本次 run 的投影覆盖层。没有尾部时也完成一致化；有尾部时沿用现有 WAL、提交回执、检查与 checkpoint 流程，首个尾部提交携带同一有效 header。
- 不直接改写旧 canonical 版本或共享投影缓存，不关闭原生 header 和前缀检查。

## 验证

新增回归使用临时目录中的真实 V3 Adapter、原生 codec、恢复读取器和 ProjectionLifecycle，不读写用户实际历史。

1. 原工作目录失效、原生空间已准备、没有新增尾部：新 Lifecycle 实例成功恢复，投影最终检查使用有效 header，原生文件不变，未产生 canonical 追加。
2. 同样条件下存在新增尾部：成功恢复并提交，追加事件与回执保持正确版本和原生修订号，header 与实际原生文件一致。
3. 已登记 catalog 的非 `cwd` header 字段被篡改：拒绝恢复，原投影和原生内容不被该恢复操作修改，不追加 canonical 事件。
4. 实际原生 header 的 `cwd` 偏离已登记值：仍由严格原生 header 校验拒绝，投影不被提前一致化。

以下检查通过：

```text
pnpm exec vitest run packages/projection-lifecycle/test/v3-effective-header-recovery.test.ts packages/projection-lifecycle/test/close-recovery.test.ts packages/adapter-dsh-0-1-5/test/migration-recovery.test.ts
15 tests / 3 files passed

pnpm --filter @linmu/dsh-session-projection-lifecycle typecheck
pnpm --filter @linmu/dsh-session-adapter-0-1-5 typecheck
```

## 兼容边界

同期的投影缓存隔离修复将实例和 profile 纳入缓存身份。之前只按 branch 生成、且恢复描述符仍引用旧缓存位置的 run，会继续在恢复时被 `Projection recovery base cache identity mismatch` 拒绝；本次 header 修复不迁移此类旧缓存，也不放宽跨实例缓存校验。新 scope run，以及没有引用该旧 base cache 的 run，适用本次恢复修复。

若将来需要恢复旧 scope 的未提交尾部，应单独提供受控兼容流程：核实旧描述符、缓存 manifest、run 所属实例/profile 及原生前缀后只读恢复旧投影，尾部提交成功后再生成当前 scope 的缓存。不可仅因旧路径存在就自动接受它。本次不包含该历史迁移。
