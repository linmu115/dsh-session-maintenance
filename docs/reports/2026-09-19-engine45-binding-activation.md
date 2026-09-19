# Engine .45 与 Vault 绑定管理激活

2026-09-19，按当前任务用户要求完成提交推送、项目地图更新及当前安装版替换。独立执行，无子代理或其他任务写入协调。

## 安装与保留范围

- Engine 0.1.33-rc2.45 / Dashboard 0.1.7，构建来源 ab63451。发行目录为本机 maintenance/engine-0.1.33-rc2.45-vault-binding-20260919。
- Obsidian Companion 0.7.0-rc2.4，功能提交 d162f5b，安装到此前已绑定的 math Vault。安装器备份原插件，官方 CLI 核验原生 Vault 路径后重载成功；main.js 与候选构建字节一致，manifest/style 按安装器换行规范一致。data.json 字节和绑定修订 1 均未变化。
- 发行包内配套 DSH 接入插件为 .31；现有实例兼容的 .29 未替换。保留已完成任务安装的 ThoughtDAG、Split Panes 等其他插件；1,166 个受校验插件文件、profile 包声明/锁文件/patch 和同步策略未变化。
- DSH 侧 CLI 功能已在独立 dsh-obsidian-bridge 仓库 main 的 d3b21f7 提交并推送，本轮核对远端一致；它不属于 Obsidian Companion 的本轮改动。

## 停止与启动证据

更新前无活动托管 run 或后台 job，目标 i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926 / web 已停止。旧 Engine PID 45616 经 SIGINT 正常退出，shutdown.requested、shutdown.drained、owner.released、shutdown.completed 及 stop-verified 回执完整，forced=false。没有删除锁或改数据库运行状态。

首次退出检查因命令行正斜杠与 Launcher 配置反斜杠不同而拒绝，未发信号。修正本地 Stop-Maintenance 的完整参数比较，保留进程、可执行文件、独占控制台和回执检查；语法及三个参数边界检查通过后正常退出。部署辅助脚本首次在正常退出后读取已清理的 connection.json 失败，改用预先核验的旧 PID 和正式退出回执继续；此时尚未切换安装配置。

备份维护数据库、Launcher 配置、实例证明、接入记录、同步策略、profile 配置及原 Vault 插件状态。新 Engine PID 12332、动态 origin http://127.0.0.1:54763；正式 repair 返回当前实例 connected，重新核验所有保留文件。Launcher 已发出打开请求并核对现有正式进程，未替用户启动 DSH 实例。Open-Maintenance 的入口检查已改为读取当前 Launcher 版本指向。

## 验收与边界

Maintenance 55 项相关测试通过，发行时再次通过 32 项版本接入检查，43 项发行文件可移植检查通过；Obsidian 21 项相关测试、两侧类型/构建检查通过。版本更新后的发行过程保留已有源码修改，没有绕过旧归档内容不一致的校验。

新 Engine 真实只读接口：health 200；扩展 business-panels 200、6 ms，返回 GPT、Obsidian、ThoughtDAG 三组；business-pages 200、1 ms；已登记实例 2 项、3 ms；DSH 停止时现有 Vault 在线且可管理、修订 1、27 ms。时间是本次单次测量，不代表持续延迟保证。

浏览器控制连接失败，实际安装版视觉及点击交互未验收；此前合成页面交互验证仍有效但不能代替实际安装版。没有进行真实新建绑定、解绑、笔记编辑或模型调用，Windows 文件夹选择视觉未验收。

本机证据根目录：D:/AI/DeepSeekHarness-Plugin/artifacts/offline-vault-binding-20260919；prepared.json、backup/、installed.json、companion-installed.json、readonly-verification.json 与 release-final/。备份和本机状态不推送到 Git。
