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
