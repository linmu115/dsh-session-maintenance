---
id: IMP-image-startup
kind: implementation
title: 图片升级后的历史恢复与启动兼容
status: current
summary: 严格接纳自身 portable 凭据，登记 GPT dev.4 并更新实际构件验收与引擎入口。
---

Engine 0.1.33-rc2.32：references-remap.ts 校验 Maintenance 自身的惰性历史凭据；extension-gpt-compat manifest 增加 0.5.0-dev.4；runtime-attestation 增加对应 Engine 版本。

79 项适配器及扩展测试、11 项扩展及构件校验测试通过。实际待恢复操作 426 个事件已校验并通过正式恢复流程持久提交。宿主绑定与 GPT 格式重新验证后生成 19 项构件回执。原历史、待提交记录和保护校验均保留。用户实例就绪与真实会话发送尚待确认。过程见 [[HIST-image-startup]]。


后续部署验证补充：独立适配 worker 同步构建后，正式 repair 接入通过（connected，无 issues）。23:05:23 Launcher 已就绪；新运行 running，旧运行 recovered；认证后页面 HTTP 200。类型检查通过。详见 [完整开发历程](../history/image-startup.md)。
