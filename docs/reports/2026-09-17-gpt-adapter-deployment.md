# GPT 独立 Adapter 配套构件与副本绑定

用户要求重新生成独立 Adapter 的配套引擎与格式绑定回执，并接入 0.1.5-rc.2 副本。

## 已完成

- 重新生成 Engine 0.1.33-rc2.29、Maintenance 插件 0.2.26-rc2.23。插件也包含 Core 绑定实现，必须与引擎配套升级；新增该版本的接入许可。
- 41 项格式/接入回归通过，Engine 类型检查通过；发布可移植性检查覆盖 41 个文件。
- 用副本之前的真实历史验证新 Adapter 完整恢复，同时确认普通 V3 decoder 仍拒绝插件专属事件。
- 备份运行数据库、50 个会话目录、旧回执、插件配置及生命周期入口，通过正式 beforeStop 流程停止副本，确认无未关闭运行。
- 通过官方 profile 安装流程替换 Maintenance 插件，1097 个受保护文件哈希一致，包括其他插件和主实例配置。
- 生成独立 Core receipt 与 19 项构件回执：Adapter dsh-gpt-compat，format dsh-gpt-compat-v1-jsonl-zstd，能力 dsh-gpt-compat/session-v1。
- 切换本机 Engine，按官方死进程恢复流程取得写所有权；repair 返回 connected、独立 Adapter 和零问题，生命周期入口指向新引擎。

## 当前验收边界

引擎和插件已经安装，回执与实例绑定已通过；副本已正常停止，等待用户在原生启动器点启动。当前工具不提供原生启动器控制。尚未把这次启动、Core 实例探针和真实模型调用记为通过；不能沿用旧全局重打包的真实调用结论。

本机回滚与验收材料保存在 GPT 插件 artifacts/gpt-adapter-upgrade-20260917。其中含私有配置和会话证据，不进入 Git。旧构件保留，原始会话与 Canonical 数据未清理。
