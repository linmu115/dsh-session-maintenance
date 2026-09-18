---
id: VER-sync-ui-release
kind: verification
title: 本轮真实UI、独立安装与未激活边界
status: current
relations:
- relation: verifies
  to:
    record_id: IMP-sync-ui-release
sources:
- path: ../changes/2026-09-18-extension-navigation-hierarchy.md
- path: ../changes/2026-09-18-sync-sections-and-current-scopes.md
- path: D:/AI/DeepSeekHarness-Plugin/artifacts/single-bridge-20260918/dashboard-sync-sections-ui-verified.json
- path: D:/AI/DeepSeekHarness-Plugin/artifacts/maintenance-engine39-install-20260918/installed.json
- path: D:/AI/DeepSeekHarness-Plugin/artifacts/bridge-folder-binding-20260918/installed-verification.json
---

# 本轮真实UI、独立安装与未激活边界

以下是2026-09-18本轮检查，旧验证记录仍保留自己的版本与日期，各测试组可能交叠，不累加成唯一总数。

| 对象与版本 | 结果 | 边界与来源 |
| --- | --- | --- |
| Dashboard .1.4扩展层级 | 已静态部署并通过实际浏览器检查 | Obsidian内双子页、ThoughtDAG不出现Obsidian绑定控件、切回保留信息页；1088px视口无横向溢出，所收集console error为空。源码报告extension-navigation-hierarchy记录主任务验收。 |
| Dashboard .1.5同步页 | 已静态部署，2026-09-18T08:19:25Z真实检查通过 | 双标签载入/切换、卡片padding、运行范围默认折叠；未保存或修改名单。见dashboard-sync-sections-ui-verified.json。 |
| .1.5源码/Engine .39范围修复 | 27测试文件89项、两组件typecheck/build通过 | 合成夹具覆盖草稿不保存、ARIA键盘操作、过滤离线/历史run与保留真实不同在线run；不代表真实Engine .39已运行。 |
| Engine .39发行与独立安装 | 43产物文件可移植性检查；安装27文件逐项hash通过 | commit06027da；8份配置/入口已备份且未变。installed.json明确activated=false、restartExecuted=false，版本pin仍.38。 |
| Engine .39在线范围过滤 | 待正常激活与真实核验 | .38运行中旧activeScopes仍可能含历史；静态UI折叠不等于根因闭合。 |
| 正常停止/重启 | 外部正式入口仍不可用 | 需Launcher停止意图、正常flush/drain/close及最终closed回执；不使用直接shutdown或进程终止替代。 |

没有将未检查的深色/窄屏/完整键盘视觉、Core引用气泡和跨端业务往返计入通过。同步真实检查只涉及页面展示与切换，不修改用户选择。8:19回执里的“文件夹绑定包待安装”属于当时状态，后续Bridge/Companion安装由外部地图和主任务回执管理，不从旧回执推断当前插件状态。

本轮地图维护另运行project_map validate、Archify architecture/workflow validate、render_map与map_catalog register；这些检查只证明文档与图源可解析、可渲染，不替代产品验收。

## 08:32 UTC 后续启动卡点（未解决）

用户正常停止DSH后，主任务核验原run关闭与Launcher最终回执，Bridge .4.1-rc2.2 / Sticker .7.4-rc2.4随后安装。外部installed-verification.json（08:31:47Z）明确verified-installed-not-activated、runtimeStarted=false，导入、metadata hash及其他配置保留检查通过。

之后正式Start在08:32:23/54 UTC的prepare阶段exit1，Launcher trace记invalid-json；这只表明未取得合法provider回执，不能凭错误标签确定JSON本身是根因。证据位置为 `C:/Users/19717/AppData/Roaming/in.dsh-plug.dsh-launcher/runtime-lifecycle.trace.log` 对应时间点，主任务继续只读排查。此截点目标DSH stopped，Engine .38 ready，.39仍未激活，**不能记为已恢复启动**。本地图不复制可能含运行参数的原始trace正文。


### 接入指纹修复（保留失败前因）

2026-09-18 08:40 UTC，确认prepare拒绝原因为保存的Maintenance接入fingerprint仍对应旧插件/profile配置；不是attestation构件失败。插件及patch升级使其失配，provider在stderr报错而stdout为空，外层才记录invalid-json。备份后通过正式integrations repair验证本目标，恢复connected/issues=[]，其他绑定、同步范围、profile包与配置均不变。证据：D:/AI/DeepSeekHarness-Plugin/artifacts/bridge-folder-binding-20260918/start-binding-repaired.json。随后单一控制方执行Start，08:41:53 prepare已成功；后续running身份仍需单独核验，不能以prepare成功替代。


### 正式启动结果

本轮正式Start最终成功：RC2副本/web为running，新origin为http://127.0.0.1:27583，boot为05c53aef-7f18-465e-b773-1fc7750b66e7，run-2f0d3ad7-9778-43fc-857b-c6258c9ecc22为running，Engine ready，all/revision0。端口仅本次证据，不写入固定绑定。准备完成至web入口约40秒；旧boot日志不能归入新启动故障。运行恢复不代表外部浏览器bundle根因、真实folder绑定或所有引用交互已通过。Engine仍.38，.39未激活。


### 引擎升级门禁修复与旧进程退出限制

2026-09-18 用户要求激活升级时，核验发现已打包.39的attestation engineVersion白名单仍截止.38，直接切换将被新版自身拒绝。最小修复92eca79加入.39/.40精确白名单，版本推进.40；32项回归及类型/构建/可移植性检查通过，新发行目录独立安装27文件校验通过。当前.38运行未变，.40尚未激活；旧.39保留作证据。

旧PID40736无控制台（AttachConsole错误6），.38无正式Engine stop/HTTP drain/IPC；不能把Windows process.kill(SIGTERM)冒充优雅退出。隔离fixture验证Start-Process Hidden保留console并能正常触发SIGINT；双击入口冷启动改用既有隐藏控制台启动脚本。CheckOnly仅验证当前连接；新引擎真实启动/退出还需后续核验。已做SQLite只读在线快照，但有一个active run，该快照不等于关闭后的全状态备份。一次性退出旧后台进程需明确例外授权，不自动执行。


## Engine .40 已激活（2026-09-18 最终续记）

当前运行版本为 **0.1.33-rc2.40**，PID51548，健康检查ready。以下结果替代本记录较早的“.38仍运行/.39或.40未激活”状态；旧段落保留为排错过程。原.39的版本枚举门禁只接受到.38，故没有激活.39；.40补齐.39/.40并包含在线activeScopes过滤。构建提交92eca79，32项测试、类型检查、构建及发行包校验通过。

用户正常停止副本后，确认会话closed、Launcher finalized/closed、无活动任务并完成最终备份，按用户明确的一次性例外结束旧.38 PID40736。这不是正常退出，授权不延续到后续重启。新.40 PID57996随后实际通过隐藏控制台SIGINT正常退出，取得requested、drained、owner.released、completed回执，再正常启动为PID51548；没有删锁或改运行状态数据库。正常Engine停止脚本仅支持可核验且未共享的控制台，并要求无活动托管run或任务；不能据此宣称DSH Launcher Stop/Restart已接通。

同步接口实测：原离线实例activeScopes为0，当前RC2副本为1。看板实际显示Maintenance与Codex并列子栏目，离线实例显示无在线运行；未修改同步名单、Vault绑定或笔记。通过正式integration repair刷新升级后失配的接入指纹，其他绑定、范围、包及配置保留。Launcher正式Start成功：副本/web running，boot 51386209-f905-4c6f-95d2-33b2b28e71e8，run-8a67195d-e8b0-4dc2-85f5-04767d91770e running，scope all/revision0。

本次看板地址http://127.0.0.1:58529/dashboard/，DSH地址http://127.0.0.1:17118；均为动态端口证据，不写入固定绑定。最终证据：D:/AI/DeepSeekHarness-Plugin/artifacts/maintenance-engine40-install-20260918/activated.json；最终备份位于同目录final-state-backup；正常退出回执C:/Users/19717/AppData/Local/DSH-Session-Maintenance/logs/engine-lifecycle/57996.jsonl。外部浏览器插件bundle故障根因、完整引用往返及真实folder绑定交互不属于本次已通过项。
