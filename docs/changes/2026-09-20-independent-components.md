# Maintenance 独立组件架构升级

对应候选版本：Engine 0.1.33-rc2.56 / Plugin 0.2.26-rc2.34。依据用户已确认的 2026-09-20 架构文档与本次「按文档对各个插件进行架构升级」指令。

## 已实现

引擎独立、宿主格式检查迁入 adapter 包、同包双入口、统一业务 SDK 与目录、镜像默认关闭、无 Launcher CLI、受管启动/失联门禁。

技术入口：[实现](../../docs/deployment/independent-components.md)。本轮只有源码和候选产物，尚未安装到实际实例；不以单元测试替代真实数据验收。

## 依赖与使用

Core 独立于 Maintenance、Bridge、DAG 和贴纸。DAG → Core；Bridge → Core；普通贴纸 → Core + Bridge；Companion 只对接 Bridge。Maintenance 可选，但已注册实例必须在线启动，失联暂停持久修改，恢复先补齐回执，解除注册须完成收尾。未注册实例独立运行。

普通安装、无 Launcher 启停、连接页及故障处理见 Maintenance 发行包 README；adapter 构建、目录与启停见随包 ADAPTER-AUTHORING.md。不要沿用作者本机 Home、令牌、Vault 绑定或旧构件回执。

## 验证与保留边界

当前检查覆盖合成会话、临时存储和自动交互。整体证据在本次交付目录的 implementation.md 与测试回执；没有写入真实 Home、Vault、Codex 会话或 Launcher。DAG Maintenance adapter 重构、GPT Compat 完善、已弃用 Codex Runtime、跨实例全局绑定按确认范围暂缓。Codex 双向维护当前无已验写 adapter，保持关闭。

## 本轮验证记录

- 30 个子项目构建通过；Engine、接入插件类型检查通过。
- 末次广泛回归 714 项中 712 项通过；剩余两个旧预期修正后，插件版本兼容 1 项、服务就绪/禁止自动拉起 4 项分别通过。保留原始失败 JSON，未声称重新执行全部 714 项。
- adapter 目录 4 项通过，包含自建宿主的检查入口；稀疏投影 catalog 恢复回归通过。
- 正式候选 candidate-r5 搬到隔离合成目录后，初始化、Engine 启停、短期看板登录、adapter 发现与加载通过；371 项文件校验值全部匹配。
- 实际宿主后端模块的安装检查只创建合成会话，验证追加、flush、重开、只读写入拒绝；未安装到真实实例。
- 发行构建清除含本机路径的区段注释，运行 JS/JSON 未检出作者目录。实际全新机器、完整 DSH/模型发送和真实 Vault 界面仍需验收。
