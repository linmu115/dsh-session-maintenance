---
id: OBJ-runtime
kind: object
title: 原生空间、运行租约与持久回执
status: current
summary: 可复用原生空间是受控运行材料，回执证明提交而非仅收到请求。
sources:
- path: ../../packages/contracts/src/native-session-space.ts
- path: ../../packages/contracts/src/projection.ts
- path: ../../packages/projection-lifecycle/src/native-space.ts
---

# 原生空间、运行租约与持久回执

原生空间按实例、Profile、分支和 Adapter 格式族隔离。prepare 恢复未提交尾部，按规范内容差异更新文件，再交给宿主持久化接口。正常关闭保留空间；它不属于插件安装目录。

runId、leaseId、operationId 分别识别运行、租约和幂等操作。WAL 先保存写入意图，与规范提交、投影水位及回执共同支持恢复。原生事件数不必等于 Canonical 行数，水位由 Adapter 验证。

[NativeSessionCodec](../../../../packages/contracts/src/native-session-space.ts)拥有物理文件和原生头格式；[运行及提交回执](../../../../packages/contracts/src/projection.ts)定义投影身份；[持久空间实现](../../../../packages/projection-lifecycle/src/native-space.ts)负责发布。接口 [[IF-runtime]]，编排 [[MOD-runtime]]。上下文释放回执另见 [[IF-native-context]]，不能用一般追加回执代替释放证明。

Launcher handle 另保存目标实例/profile、PID、进程创建时间、OS 启动时间及已观察退出时间，供启动前恢复判断。进程号本身不是稳定身份；无法证明进程树退出时不得自动收尾。正式 Broker 恢复完成与投影清理回执共同允许后续启动，见 [[IMP-startup-recovery]]。
