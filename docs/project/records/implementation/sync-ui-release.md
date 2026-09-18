---
id: IMP-sync-ui-release
kind: implementation
title: 同步与扩展页面修复及 .39 待激活状态
status: current
summary: Dashboard .1.5已静态部署并完成限定UI检查，Engine .39只安装文件，在线范围过滤未在运行引擎生效。
relations:
- relation: implements
  to:
    record_id: REQ-sync-extension-navigation
sources:
- path: ../changes/2026-09-18-extension-navigation-hierarchy.md
- path: ../changes/2026-09-18-sync-sections-and-current-scopes.md
---

# 同步与扩展页面修复及 .39 待激活状态

扩展层级由提交5c4f1b9实现、e8c5d01补记真实验收；同步子栏目与范围修复由06027da实现。Dashboard .1.5已静态部署到现运行的Engine .38发行目录，保留之前资源及备份，不重启引擎。用户选过的插件页和同步子页保持挂载，保留未确认动作身份或未保存草稿；整个同步主页面离开或全局刷新仍沿用卸载行为，不承诺跨刷新保留草稿。

当前范围卡片原先缺少样式容器，且Engine把未关闭历史run都作为activeScopes，造成31条相同web/revision0铺开。前端修复padding、表单间距和响应式，范围列表默认折叠、展开限高；不同run保留各自标识，不做假去重。Engine .39使用RuntimeBroker.isRunActive过滤真正在线run，再计算pendingActivation。run-center只有持久state，不足以在前端推断在线，因此未增加猜测式过滤。

Engine .39归档已安装至独立 `engine-0.1.33-rc2.39-sync-sections` 目录，27文件逐项哈希验证、8份当前入口/配置备份且保持不变。此时当前Engine仍 .38；.39在线过滤必须正常激活后才生效，不能将UI成功或归档安装当成后端根因已在运行环境闭合。

切换须联合更新Launcher runtime-lifecycle入口、当前profile attestation的engineVersion/path/hash，以及Open-Maintenance的发行目录。动态读取Launcher入口的Start-Session-Maintenance无需另写版本；先核验正常关闭回执再启动。当前Launcher外部Stop/Restart不可用，直接runtime shutdown不能代替beforeStop，禁止强杀、删锁或改运行状态。详细责任见 [[MOD-host]]。

Maintenance作为独立可选维护方提供公开业务Adapter及信息页注册，Bridge/Core/贴纸保留自己的业务真源和运行时职责。UI按插件显示不改变数据归属，信息页动作仍由对应提供方执行；没有为了验收修改用户同步名单。回执与验证见 [[VER-sync-ui-release]]。


### 接入指纹修复（保留失败前因）

2026-09-18 08:40 UTC，确认prepare拒绝原因为保存的Maintenance接入fingerprint仍对应旧插件/profile配置；不是attestation构件失败。插件及patch升级使其失配，provider在stderr报错而stdout为空，外层才记录invalid-json。备份后通过正式integrations repair验证本目标，恢复connected/issues=[]，其他绑定、同步范围、profile包与配置均不变。证据：D:/AI/DeepSeekHarness-Plugin/artifacts/bridge-folder-binding-20260918/start-binding-repaired.json。随后单一控制方执行Start，08:41:53 prepare已成功；后续running身份仍需单独核验，不能以prepare成功替代。


### 正式启动结果

本轮正式Start最终成功：RC2副本/web为running，新origin为http://127.0.0.1:27583，boot为05c53aef-7f18-465e-b773-1fc7750b66e7，run-2f0d3ad7-9778-43fc-857b-c6258c9ecc22为running，Engine ready，all/revision0。端口仅本次证据，不写入固定绑定。准备完成至web入口约40秒；旧boot日志不能归入新启动故障。运行恢复不代表外部浏览器bundle根因、真实folder绑定或所有引用交互已通过。Engine仍.38，.39未激活。
