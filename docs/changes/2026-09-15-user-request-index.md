# 用户请求索引：原生请求身份和固定上游目录

实现范围：补充规格 W19、NCA01–NCA05 的共享合同、DSH 0.1.5 Adapter 和 Engine 查询。模型工具、HTTP 路由、UI 及版本发布由同阶段集成任务接入。

## 行为

- `UserRequestIndexService.list` 从当前运行和原生会话解析所属会话；传 `referenceId` 时经权威引用确定源版本与完成截止，先裁剪授权前缀，再生成请求、关联和游标。
- 请求身份是所属逻辑会话和 canonical event ID 的稳定摘要，不使用页面轮次或可变化的序号。原生 `turn/start/end` 和 MCSF topology 提供执行关联；中途补充保留各自请求，完成、失败、取消与待执行状态不等于用户需求是否解决。
- 来源分类与 Reader 共用。原生可信 `kind:user` 提交纳入；运行上下文、技能目录、Annotation 包和插件上下文排除。用户粘贴相同文本或标签不被排除。旧记录无法证明来源时只返回待核验身份，不返回正文、附件或可执行定位。
- 列表每页最多 25 项、完整 JSON 最多 16,000 字节；预览最多 384 Unicode 码点。长请求通过 `requestId` 与 `nextTextCursor` 分页读取原文，无代理摘要。附件只提供最多 8 个轻量身份，明确剩余数量，不展开数据。
- `locate` 返回源版本及稳定问答范围，供窗口选择和上游读取使用。`requestId` 不与既有披露操作 ID 混用，上游读取入口另用 `userRequestId`。
- 暂停、撤销和授权修订在读取前及返回前核验；游标绑定版本、引用修订与使用状态修订。已经清理的源版本不可悄悄替换为最新版本。
- 模型目录文字与返回包装计入现有 `ContextReadBudgets`，与上游正文、搜索共享当前执行的累计额度。用户预览是内部受信任选项，不开放为模型参数；它保持授权和单页硬限，不消耗模型执行预算。
- `listSession` 为静态 Maintenance 看板提供相同的分页目录，不要求 DSH 运行实例；不维护第二份请求全文、整图请求副本或原文快照。底层读取复用现有 canonical 固定版本存储，目录输出不会带入回答、工具正文或附件数据。

## 验证

合成 Adapter 测试覆盖来源可信性、粘贴标签、补充与失败/取消、稳定身份、替代事件排除、MCSF topology、长 Unicode 原文和附件元数据，以及完成位置的授权前缀。

Engine 测试使用隔离的真实 canonical/Projection 数据：100 轮源限定第 40 轮、分页/问答定位、旧游标失效、静态非运行阅读、长原文逐字重建、暂停/恢复、撤销、目录与正文共用预算、用户预览不消耗模型预算。原生输入/输出 home 目录摘要保持不变。

检查命令：

```text
vitest run packages/adapter-dsh-0-1-5/test/request-index.test.ts apps/engine/test/user-request-index-service.test.ts --maxWorkers=1
tsc -p packages/adapter-dsh-0-1-5/tsconfig.json --noEmit
tsc -p apps/engine/tsconfig.json --noEmit
```

未操作真实会话内容、未调用模型、未修改运行副本。
