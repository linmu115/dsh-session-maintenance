# Lynn 接入组件正式安装与加载修复

用户确认正常停止后，测试实例 `i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5` 的状态核验为 stopped。已完成定向安装：**Engine 0.1.43-rc2.73**、**Maintenance 接入组件 0.2.27-rc2.46**；Lynn 与独立 GPT adapter 均为 0.1.0。通过正式目录接入 repair 更新本目标的指纹，当前 connected、issues 为空。实例留待用户启动，运行期连接与 UI 未验收。

实际安装校验暴露两个问题并已修复：

- .45 服务器 bundle 内的 YAML CommonJS 依赖在 Node ESM 中 require(process) 失败。服务端构建增加 createRequire 引导；正式安装验证器现在实际 import 宿主入口，避免仅验证包存在而漏掉模块加载失败。新 .46 在实际宿主依赖下加载通过。
- 目录扫描已识别 Maintenance 身份 web-i27c4，但 RC2 配置检查仍以物理目录 web 比较，误报 profileId 不匹配。统一以声明身份验证 Maintenance 配置；实际目录及 Web 限制仍按物理目录判断。合并重复卡片时不再向目录接入混入 Launcher 专属回执错误。

新增/相关回归：接入与 profile 67 项、宿主同步与包兼容 9 项通过；instance-integration 类型检查通过。此前完整 416 项回归与真实插件组件回验结果仍保留，未将其描述为本次新增修改后的全量重跑。

最终发行目录：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/engine-0.1.43-rc2.73-release`。58 个发行文件与 19 个安装插件文件逐项哈希一致。实际 ESM 模块加载通过，正式安装验证器的宿主 handle 读写探针通过，23 个运行构件回执哈希通过。

备份与最终 verification.json：`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/instance-install-20260922`。其他 16 个插件共 984 文件未变；除重新生成的两个接入回执，1159 个受校验文件未变。profile package.json 只改变 Maintenance 发行包指向，未重装依赖或修改 overrides/锁文件。旧 .44 与中间构件保留备份。

引擎每次切换均通过正常 SIGINT、drain、owner-release 回执验证。553 个逻辑会话、25 个派生关系、553 个成员、496 个删除标记、117 个扩展对象完整摘要不变；Vault 绑定、同步范围与主配置不变。仅当前目录接入记录的 fingerprint / checkedAt 更新，其他接入记录不变。Launcher runtime-lifecycle.json 仍不存在，未恢复 Launcher 耦合。

最终运行 Engine PID 58048；端口从 connection.json 动态发现，不作为永久地址。测试实例没有由本任务启动，用户可从 Launcher 启动「0.1.5-rc.2 测试」开展连接与功能往返验收。
