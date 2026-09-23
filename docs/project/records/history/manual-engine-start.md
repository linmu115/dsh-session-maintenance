---
id: HIST-manual-engine-start
kind: history
title: 引擎手动启动入口与旧运行回收
date: '2026-09-18'
status: current
modules:
- 运行时投影与兼容校验
summary: 区分引擎离线和运行未收尾，提供跟随 Launcher 配置的双击启动脚本。
outcome: 引擎已启动，重复运行复用同一 PID；上次运行正式恢复为 recovered。
applicability: Windows Launcher 与 Engine 0.1.33-rc2.34；脚本读取当前配置，不固定版本。
coverage_note: Codex 整理本次公开任务第 2643–2753 行，保留事件定位而非原始载荷。
history:
  path: history/manual-engine-start-20260918
  sha256: 98ffa88c43336b2d9aba21a4b1377c094159ac29b69b7009520394e07a6da400
  capture_sha256: 24f5486490402b5c5bdac4fd769ef051e54f92b6b82a360f8ae1a4ee99f69dc8
---

用户启动实例提示会话未回收，询问引擎是否未启动并要求启动脚本。实时检查发现 connection.json 对应服务离线、上次投影仍为 running；Launcher 当天曾拉起引擎并记录 ready，但检查时进程已不存在，具体退出原因未确认，不能把全部问题归因为从未启动。

旧 Start-Maintenance-Web 指向另一工具和状态目录。新增 scripts/windows 下的一对 CMD/PowerShell 文件，从 Launcher 配置读取当前版本入口，隐藏运行后台引擎、认证健康检查、互斥重复启动、保存诊断日志。只使用引擎自身的已死 owner 校验恢复，不手工删除锁或运行状态。实际首次运行 PID 48724、端口 21133 就绪；第二次运行复用同一 PID。

另核实旧 DSH 进程不在且原地址不可达后，通过 external-lifecycle afterExit 的恢复路径处理旧运行 run-26056e39-32d7-4f41-9285-198025416bd6；返回 ok，handle finalized、finalReceipt recovered，数据库运行也为 recovered。该恢复是本次人工核查后的操作，没有放入普通启动脚本。未自动启动新 DSH 实例或设置系统开机自启。
