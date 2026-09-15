# Core → Maintenance 引用目录桥接

本报告记录 `plugins/dsh-session-maintenance/src/annotation-mirror.ts` 与 Core 配套只读目录的源码实现及合成验证。它是业务目录镜像，不是新的引用、提交或撤销权威。未由本子任务提交、部署或操作真实业务数据。

## 行为

插件仅在当前实例明确配置 `annotation-records` 且可选 `annotationCoreHost.referenceDirectory.protocolVersion === 1` 时启动。通过 `ctx.inject` 跟随 Core 服务生命周期，不添加 Core 运行时包依赖。

先订阅持久变更，再分页补齐已有会话；每页最多 50 个会话头，每个会话一次最多读取 50 条引用。只保留会话 ID、修订、游标及重试状态，正文只在当前有界页面中存在。每个同步请求携带当前 `runId` 和 Core 原生会话 ID，由 Engine 映射逻辑身份。

Core 一页可以拆成多个不超过 480 KiB UTF-8 的请求，兼容 Engine 512 KiB 上限。每个请求仍最多 50 条。全部条目的 `saved`/`unchanged` 回执必须具有有效对象修订和来源修订，才推进该 Core 页；部分、缺失、冲突或延迟回执均保留待同步页。较旧修订和变化的目录游标触发重新读取。相同来源修订的不同页面使用逐条幂等回执。

失败按会话退避（1 秒起，最多 30 秒），其它会话继续同步；未知原生映射或来源映射尚未就绪同样保留重试。只发送明确 tombstone，缺席不构造删除。卸载取消订阅、定时器、初始化连接与网络等待，晚到的响应不能消费新的修订。进程重启后从 Core 持久目录补齐。

活动固定上游发送真正的 `source.upstreamReferenceId`；Engine 依据目标、实例/profile 和权威上游对象抑制重复目录行，镜像本身保留可追溯。无正文 tombstone 由 Engine 保留旧镜像的来源定位；未知 tombstone 仍建立删除状态，防止旧修订复活。Core 不导出恢复图授权集合。

## 验证

`plugins/dsh-session-maintenance/test/annotation-mirror.test.ts` 的 16 项合成测试覆盖启动补齐、两级分页、多字节拆批、更新与明确删除、无缺席删除、独立会话重试、延迟/冲突回执、部分回执、旧修订、分页变化、同步中编辑、重启恢复、卸载与晚响应、配置与可选能力门禁，以及实际连接桥取消。

插件类型检查与构建通过。桥接、归档、宿主和扩展列表 4 个测试文件合计 29 项通过。Core 轻量目录与存储、宿主及包契约 6 个测试文件合计 29 项通过，Core 类型检查和构建通过。不以这些合成结果宣称已经在真实引用上执行过同步。
