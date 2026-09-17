---
{
  "id": "HIST-image-startup",
  "kind": "history",
  "title": "GPT 图片升级后 Launcher 阻塞的恢复过程",
  "date": "2026-09-17",
  "status": "current",
  "modules": [
    "运行时投影与兼容校验"
  ],
  "outcome": "修复已部署，Launcher 已就绪、Maintenance 新运行正常；用户真实会话发送仍待验收",
  "summary": "GPT 图片升级后 Launcher 阻塞的恢复过程；保留失败阶段、用户纠偏与实际验证边界。",
  "applicability": "DSH 0.1.5-rc.2；Core 0.3.12-rc2.13；GPT 0.5.0-dev.4；Maintenance Engine 0.1.33-rc2.32。",
  "coverage_note": "Codex 于 2026-09-17 整理；本任务公开来源 701–1281 行。扩展为完成阶段快照，保留此前截止 966 行的索引。仅保存定位与指纹，不复制原始载荷或隐藏推理。",
  "history": {
    "path": "history/image-startup-20260917-complete",
    "sha256": "435fcbd7107f40482f1668491a60a71084529e63db59e6e792d29cd56316ba64",
    "capture_sha256": "461c8b4d79eea3b63d355b0d88759416ceb6581660e2c61d8b1ffec6266de89e"
  },
  "related_records": [
    "IMP-image-startup"
  ]
}
---

# GPT 图片升级后 Launcher 阻塞的恢复过程

用户报告 Maintenance 可能未重启、Launcher 启动不了，要求先修启动再整理地图。

[查看依据：用户调整任务优先级](history-event:EVT-f14f143d9aab05393912)

只读检查发现旧运行处于 recovery-required。适配器在恢复分支会话时拒绝自己生成的 maintenance/canonical-event；该会话继承了 portable 投影的原始凭据。另有两处升级遗漏：GPT 插件版本名单只到 dev.3，校验回执仍指向旧插件文件。

恢复器仅接纳经过严格校验的 Maintenance 凭据：已标记 ignorable、没有活跃 surface/reference 操作、转换器身份匹配、canonical schema 有效、内容与投影策略一致。凭据保存在适配器证据存储中，恢复时校验身份后还原；没有放宽任意未知事件，也没有删除或跳过待恢复记录。

同时登记 GPT 0.5.0-dev.4，将 Engine 升为 0.1.33-rc2.32。79 项适配器与扩展测试通过；补充 dev.4 明确验收后，扩展与构件校验相关 11 项通过。对实际待恢复操作只读归一化成功，共 426 个事件。

[查看依据：实际待恢复操作只读验证](history-event:EVT-a8c3e3b7f621d897b537)

使用实际宿主再次执行绑定收集、持久格式与 GPT 格式检查，再更新 19 项构件回执和 Launcher 引擎入口。重启 Maintenance 后，通过正式 external-lifecycle afterExit 重试恢复，旧运行 recovered、句柄 finalized。

[查看依据：旧运行与句柄恢复完成](history-event:EVT-73ac295b57e66220f496)

未直接修改数据库状态，没有丢弃 WAL 或会话文件。已唤起 Launcher；截至此索引范围尚无新的实例就绪日志，因此恢复通过与用户重新启动成功分别记录。


## 后续启动验证与纠偏

用户再次点击仍失败，证明旧运行恢复不等于新实例可启动。继续检查发现实例绑定指纹未更新；执行正式修复接入时，又发现发布目录内的适配检查 worker 仍是旧版，拒绝 GPT dev.4。同步构建 worker 后，正式 repair 检查通过，接入状态 connected、issues 为空，且没有重新安装其它插件。

重新触发 Launcher 后，2026-09-17 23:05:23 报告当前副本已就绪；Maintenance 新运行 running、旧运行 recovered。使用启动地址及正常 Cookie 流程读取页面返回 HTTP 200、HTML 有效。真实用户会话发送尚未代发。

[查看依据：已认证页面验证成功](history-event:EVT-cdc23970a73efde602c4)

后续部署必须同时检查引擎、独立适配 worker、宿主格式回执及实例绑定，再以 Launcher 就绪和新运行状态验收；仅重启引擎不足以证明升级完成。
