# Maintenance 0.1.16 / 插件 0.2.18 启用记录

2026-09-06 11:59（北京时间），按用户要求在 DSH **0.1.2-rc.1 / web** 投入使用，等待用户界面验收。

## 运行与来源

| 组件 | 当前版本与来源 |
| --- | --- |
| Maintenance Engine | 0.1.16，`0ff6081c9b888da1919acbec98849c2f68470ae2` |
| Maintenance 插件 | 0.2.18；已安装 11 个文件逐一匹配最终归档 |
| Session Context Menu | 0.3.2，保持原宿主 |
| Launcher | 版本标识 0.2.2，Hook 源码 `47b2d5da6b46d169916c3353ada3680a245e5107` |
| 元数据 | 独立 `metadata.release-20260906-0-1-16.sqlite`，schema 20 |

最终发布目录：`D:/AI/DSH-Plugin-Releases/maintenance/engine-0.1.16-plugin-0.2.18-scm-0.3.2`。使用其中 `packages-r2/` 和 `installation-r2/`；此前同版本候选及第一轮包作为历史证据保留，不作为当前启动入口。

| 产物 | SHA-256 |
| --- | --- |
| Engine + Dashboard tgz | `d92e12aa57b253770ed135d28eeebb3d8f38f9082c8e8039ae3d1c760dfa600a` |
| Maintenance 插件 tgz | `92c0bfe994d18b22748c97ef17bf26a49c410c8b5ac26b1dfa4a19bc5ca91ceb` |
| Launcher exe | `29e094df99ff278a465ba9b6e46e99185d2b22b47ab2a5819315f9cc074d532c` |

当前实现包括 SM-05、SM-06 局部职责拆分、SM-07、SM-08、SM-09、SM-11 与 SM-13。部署中发现并修复了两个启动问题：

1. `04988c6`：Engine 与 Provider 使用共享连接描述契约，兼容原四字段和新增 pid/ownerId 的六字段文件。
2. `0ff6081`：启动恢复完成后才监听 HTTP，连接文件完成权限设置后原子发布。旧实测任务曾在 running 后又被启动恢复改回 queued；修复后的真实冷启动只有 queued → running → progress → completed。

## 最终验证

最终源码树 `4da34ac18251220d7963f16d5f8b972795432715` 与子代理提交 `9baff30da740c14320c3cb987074ce49bd1fc027` 的 tracked tree 完全一致。**174 个文件、564 项测试全部通过**，单 worker、单项超时 30 秒，325.57 秒，无未处理错误。仅排除子代理旧的三个未跟踪审查入口；全部 tracked 测试参与。全仓构建和类型检查通过。

归档可移植性检查覆盖 29 个文件；真实安装包验证默认看板路径发现、无关目录启动、页面与脚本、一次性登录、会话鉴权及正常 CLI 退出。完整日志为发布目录 `evidence/final-full-tests.log`，SHA-256 `0ab0cabb12b09a3a0554539d60b75997fdbef0aaddba773fe16963e54b0ec7f7`。

实际部署从无 Engine、无 connection、无 writer owner 状态通过 Launcher 冷启动。核查时 Launcher PID 11532、Engine PID 67068、DSH PID 66072，DSH 由 Launcher 持有，Engine 路径指向 `installation-r2`。这些 PID 仅表示本次核查时的身份，重启会改变。

实际 DSH 认证登录、Maintenance 状态代理、插件生成看板登录入口、一次性凭据领取、看板 UI 会话及概览接口均成功。当前投影运行 `run-75bef1a8-aab9-4697-94b6-91eea2b1595b` 为 running，340 个会话，待处理操作 0。存储引用预览成功，回收批次为 0。没有执行浏览器自动化或模型调用，界面交互和实际正常停止/再启动由用户验收。

## 数据、回退与验收边界

旧运行先经生命周期接口停止，Launcher 正式收尾，已有 final receipt 保存。复制一致的 schema 17 数据库后，升级只作用于新文件；七组业务/历史元数据摘要一致。核查时 520 个逻辑会话、5634 个版本、53 个 Checkpoint；部署收尾及一次 prepare/abort 诊断产生正常 Checkpoint 增量。

旧数据库、对象库、运行与恢复资料、插件 profile、Launcher 二进制及配置均保留在发布目录 `rollback/`，另有旧发布目录。回退必须先保存验收后增量，再恢复匹配的程序和状态；旧 Engine 不能直接打开 schema 20 数据库。具体步骤见发布目录 `ROLLBACK.md`。

其他插件依赖、加载顺序及 cordis/工作区配置哈希均保持不变。五天历史裁剪、正文分块迁移和自动清理未启用，部署没有隔离或删除真实资料。用户可在 **0.1.2-rc.1 / web** 验收看板、统一菜单、导入进度/取消/重试、正常收尾再启动，以及只读存储预览；隔离、恢复、最终释放先使用专用测试资料。

发布目录 `release.json`、`RELEASE-NOTES.md` 与 `evidence/` 保存完整来源、运行与迁移证据。此文档提交位于打包源码之后，不改变已安装包。
