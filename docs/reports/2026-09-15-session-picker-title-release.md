# 跨会话选择器标题修复与运行副本验收

日期：2026-09-15。目标：DSH 0.1.5-rc.2 副本的 web Profile。

## 问题与结果

跨会话引用选择器有时显示生成的会话 ID，无法辨认目标。Core 已改为从官方会话列表读取持久标题，再使用可读目录名称作为回退。真实重启验收进一步发现，Maintenance 会用旧登记名称覆盖原生日志标题缓存；本次同时修复标题事件提交、物化证明、缓存恢复和故障回执恢复。

最终启动后，真实目录的 7 个工作区、40 个合格目标均与官方原生标题匹配，没有缺失原生目标或标题不一致。此前受影响会话的标题摘要与修复前原生日志保存的真实标题摘要一致，`durableTitleRecovered: true`。5 条旧目录名称仍与原生名称不同，由 Core 的原生标题优先规则正确显示；未通过批量改写旧版本来修饰验收结果。

该验收调用官方只读 session.list 和 Maintenance 目录，并执行当前 Core 的真实标题解析函数。它没有在浏览器中提交一条新引用，不代表代替用户完成整个选文、引用与模型回答流程。

## 实际安装

| 组件 | 已安装版本 | 构建源码 |
| --- | --- | --- |
| Maintenance Engine | 0.1.33-rc2.22 | `2ababa561fbcf5a5c6da2c3520445fe51f80c367` |
| Maintenance 插件 | 0.2.26-rc2.18 | 同上 |
| DSH 0.1.5 Adapter | 0.1.2 | 同上 |
| Annotation Core | 0.3.12-rc2.12 | `39a01bd` |
| ThoughtDAG | 0.4.14-rc2.9 | 本次保持 |

最终 Maintenance 修复包仅替换副本中 19 个插件的 1 个，其他 18 个沿用上一轮实际安装包及摘要。Engine 使用匹配的独立便携构件。本文档提交发生在打包之后，不改变上述构建源码身份。

## 验证

- 最终 Maintenance 工作区构建通过，标题、缓存、官方 V3 回放及故障恢复相关 32 项回归通过，当前 Engine/插件接入证明的 2 项检查通过。插件独立类型检查与便携包校验通过。
- 已安装的 19 个精确包通过独立宿主写入和冷读取探测；使用合成数据验证持久回执、上下文、目录及锁定行为。
- 实际副本通过 Launcher 正常启动，运行状态为 running；88 个运行文件与安装清单匹配。
- annotation-context、annotation-records、annotation-upstream、obsidian-links、stickers、thoughtdag 六个命名空间均 ready。
- 原生上下文状态、真实用户请求目录及所有者范围验证通过；已退役的全局维护网络返回 404。
- 数据库 schema 保持 24，没有结构迁移；既有规范正文、版本、父关系、元数据快照及 head 摘要在交接和启动后保持一致。引用数据与主实例配置保持一致。
- 副本通过插件退出接口排空，官方生命周期最后记录为 recovered/finalized，活动运行与作业归零；没有向 DSH 发送强制进程信号或手动改写生命周期状态。
- 没有发起真实模型调用、创建测试引用、编辑真实图谱或修改 Vault 正文。

详细本地证据位于独立部署 artifact 的 `validation.json`、`live-titles-after-restart.json`、`copy-installation-final.json`、`engine-handoff-final.json` 及 `host-probe/result-final.json`。这些文件含本机运行身份与诊断信息，不随公开文档提交。

## Obsidian 性能排查边界

此次性能部分为只读排查，尚未捕获用户偶发的长时间不响应。发现三个优化方向：首次跨文件定位索引未主动让出 UI 时间片；编辑器每次文档变更重新扫描全文并构建标记；DSH 内嵌页存在分开的关联轮询、DOM 观察和布局测量。

首次索引用当前源码、5,084 个合成文件（每个 20 KiB）验证，连续执行约 122 ms，期间定时器没有获得执行机会。它证明热缓存条件下的主线程占用，不能作为真实 Vault 扫描耗时或十几秒冻结的证据。后续索引查询会复用缓存和脏文件更新；内嵌标记也已有去重、可见性判断和按帧合并机制。

现场 Bridge 状态正常，复用连接的状态请求为 0–3 ms；引用数据仅数 KB，未见明显数据膨胀。现有日志缺少事件循环延迟、请求排队和阶段耗时，无法归因过去的卡顿。本批没有宣称性能问题已修复。后续可优先做索引分批让出 UI、装饰增量更新，以及不记录正文的有界耗时诊断。

## Codex 镜像与引用

设 X 为 Codex 镜像，Y 为接收引用的会话，X′ 为实际追加后形成的 DSH 派生会话。

| 操作 | Maintenance 的行为 |
| --- | --- |
| Y 跨会话引用 X | 记录固定来源版本、完成回复的截止位置与目标关系；X 仍是 Codex 镜像，不生成 X′。 |
| 原 Codex 更新，下一次启动同步 | 当启动配置已启用对应项目正文同步时，在同一 X 身份下导入新版本，再更新原生投影。当前验收副本确实使用该模式。 |
| Y 再读取旧引用 | 仍读取当时的 X 版本及固定截止位置，后续新增轮次不可见；旧版本不可读时明确失败，不静默改读最新版本。 |
| 向 X 的 DSH 投影首次实际追加 | 基于当时投影版本生成 X′，后续 DSH 内容归 Maintenance；原 X 继续接收 Codex 同步，不覆盖 X′。 |

如果引用发生在派生之后，来源可能已经是 X′。同一个标题不足以判断身份，应以真源映射为准。

核查入口为 `apps/engine/src/session-context-service.ts`、`packages/canonical-session-engine/src/codex-observation.ts`、`packages/canonical-session-engine/src/dsh-append.ts`、`packages/projection-lifecycle/src/append.ts` 及 `persistent-cache.ts`。固定版本与派生行为已有独立回归；本次未为验证而续写真实 Codex 镜像。
