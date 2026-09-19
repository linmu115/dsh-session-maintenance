# 启动前恢复部署回执摘要

2026-09-19 完成 Windows 本地安装。Maintenance 源码 `b7af3b8`，Launcher `3ee0c44`，生产构建说明 `8b9e6fe`；分支 `codex/startup-recovery-20260919`。源码工作树与安装状态分别记录，其他分支的版本不能替代本回执。

- 发行目录：`D:/AI/DSH-Plugin-Releases/maintenance/engine-0.1.33-rc2.41-startup-recovery-20260919`。
- Engine SHA256：`ea748cba45f49dec1571ebb2f5717d1e135dda85a0cb529d92d08818c7342907`。
- Launcher SHA256：`65654db084ccff2e912398242fdc26b398b09ef900c5d5e4848c62147a39cae8`。
- 备份与机器回执：`D:/AI/DeepSeekHarness-Plugin/artifacts/startup-recovery-20260919` 下 `installed.json`、`activated.json`、`binding-refreshed.json`、`binding-refresh-backup/manifest.json`。

修正版于 03:58 UTC 替换。旧 Engine PID 33616 通过正式 SIGINT、drain、owner-release 回执退出，新 Engine PID 45616 正常启动。仅更新已测试的 Launcher 指纹及 Engine pin，通过正式 integration repair；插件、同步名单、profile 和其他绑定保持不变。

04:08 UTC 核验稳定实例 `i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926 / web`，run `run-719abe69-0938-4703-9dde-5751703310e2` 为 running，boot `7ac96667-643b-433c-8533-90fafd57532b`。真实日志记录恢复前置、prepare、started，handle 的 PID 32884、进程创建时间 `2026-09-19T04:06:54.7286710Z` 与 OS 启动时间 `2026-09-19T02:46:35.5000000Z` 已保存。PID、端口和时间仅为当次证据，不作固定配置。

旧 run `run-61c1605c-ca3f-4391-a630-16ba7b942e21` 于 03:19 UTC 经备份后正式恢复，handle finalized、disposition recovered。该恢复先于最后一次 Launcher 启动，不能描述成重新制造异常后做过整链重复验收。

12 项新恢复测试、29 项 Launcher 测试及两端检查/构建通过；原 Provider 套件 9 通过、3 项 Alpha2 探测在基线同样失败。恢复进度视觉未单独验收，全部插件业务未复测。用户反馈“没问题”。完整地图入口见 [启动恢复实现](../project/records/implementation/startup-recovery.md)与[验证边界](../project/records/verification/startup-recovery.md)。
