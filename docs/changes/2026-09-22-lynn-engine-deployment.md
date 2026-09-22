# Lynn / GPT adapter 当前安装回执

后续安装已完成：用户正常停机后，Engine 升级为 **0.1.43-rc2.73**、实例接入组件 **0.2.27-rc2.46**，正式目录接入为 connected、无错误；实例留待用户启动验收。见[最终安装与修复回执](2026-09-22-lynn-instance-installed.md)。以下是此前 .71 阶段的历史记录，不代表当前仍待安装。

2026-09-22：Engine **0.1.43-rc2.71** 已安装并运行，Lynn adapter **0.1.0** 与 gpt-compat adapter **0.1.0** 已加载。7 个内部 namespace 条目全部启用，业务面板聚合为 Lynn 与 GPT 两个入口，加载错误为 0。实例接入组件新版 **0.2.27-rc2.45** 已构建，测试实例仍运行旧版 **0.2.26-rc2.44**，等待用户通过 Launcher 正常停止后安装。

发行目录：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/engine-0.1.43-rc2.71-release`。58 个发行文件校验通过；隔离环境的初始化、状态与两个 adapter 包加载通过。完整 typecheck / build 及 88 文件、416 项回归测试通过；当前真实插件组件的隔离读写回验通过。

部署备份及回执：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/deployment-20260922-1710`。旧 Engine PID 36792 经正常 SIGINT 退出，shutdown.requested、shutdown.drained、owner.released、shutdown.completed 已核实。备份包括配置、旧 adapters、独立安装描述和一致性数据库副本（805875712 字节，哈希一致）。没有删除锁或强制结束进程。

当前进程 PID 51256，端口仅为本次启动的 32661；后续从 connection.json 读取，不固定端口。程序路径与独立安装描述一致。健康接口 ready=true，数据库 schema 29，adapter 目录接口成功。Launcher runtime-lifecycle.json 未恢复；独立启动脚本以 Maintenance 自己的 engine-installation.json 为准。

升级前后逐项内容摘要一致：553 个逻辑会话、25 个派生关系、553 个工作区成员、496 个删除标记、117 个旧扩展对象。7 项配置文件（含同步范围、接入记录及 Vault 绑定索引）哈希一致。未改实例插件文件、会话数据或 Vault 内容。

尚未完成的实例步骤：稳定 ID `i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5`，物理 profile `web`，Maintenance 身份 `web-i27c4`，名称 `0.1.5-rc.2 测试`。当前仍为 unmanaged-running，bootId `ae9a2c6d-7e21-4f1e-9af5-e8eb2f3364f7`。已请求用户正常停止；当前 Launcher 没有经过回执验收的外部停止接口，依工作区约定不能直接 shutdown 或杀进程替代。停止核实后应备份并定向替换接入组件，保留其他组合插件与设置，不作整套依赖重装。

真实连接、插件数据往返、新建/续写/改名/移动/归档/取消归档/删除及 UI **未验收**。测试实例现有旧业务登记仍显示 Lynn partial、GPT disabled；新引擎包已启用不代表该实例完成握手。不能在安装接入组件前告知用户已可验收整个闭环。
