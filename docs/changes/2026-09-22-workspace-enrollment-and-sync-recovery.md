# 工作区加入、范围勾选与新会话回传修复

后续更正：用户明确保留编辑模式，直接勾选的改动已在 Engine .77 / Dashboard 0.1.16 撤回；本记录以下为 .76 阶段历史。保存等待及新会话回传阻塞仍未解决，见 [恢复编辑模式与阻塞说明](2026-09-22-restore-workspace-edit-mode.md)。

用户实测：实例新建 workplace1 并加入真源成功，但 Maintenance 未自动选中；范围勾选不直观；已选择的“计算机四大”中新会话未进入静态看板。

## 已修复并安装

当前 Engine **0.1.43-rc2.76**、Dashboard **0.1.15**；宿主接入组件保持 **0.2.27-rc2.47**，测试实例未停止或重启。本轮不使用 Computer Use。

- 加入工作区后，幂等地把该工作区加入来源实例的同步范围，保留原范围及未分组选项；不改其他实例。
- 宿主 adapter 验证并记住原工作区目录，包括空工作区，供后续新会话归属识别；冲突目录拒绝覆盖。目录规则仍在 adapter。
- 范围选择可直接勾选，再明确保存；修正没有托管运行回执就声称实例离线的文案。
- 运行配置按已经保存的目录接入身份选择，忽略旧目录注册记录。现场同时有 web 与 web-i27c4，原先取第一条，导致 SYNC_PROFILE_MISMATCH；现使用绑定的 web-i27c4。旧登记未直接删除。
- 宿主后启动时，同步状态请求触发合并后的、有间隔的对齐重试；范围未变且已 active 时不重复对齐。
- 对齐请求仅传协议要求的 revision/selection。此前将完整持久化 policy 传入严格 schema，被额外字段校验拒绝；回归改为使用完整真实配置形状。

45 项相关回归通过；宿主 adapter 构建、Engine 与 Dashboard 类型检查、Dashboard 构建通过。最终发行包 58 个文件哈希通过。Engine .74/.75 均正常 drain、owner-release 后切换；宿主代码、profile 插件依赖和会话文件未替换。安装回执按 .76 重新生成，目录 connected、issues 为空。

## 现场结果和仍未完成的部分

- workplace1 的加入请求经原正式入口重试：created=false、alreadyPresent=1、failures=[]，没有重复导入。测试实例范围由修订 6 增至 7，保留原来两个工作区并新增 workplace1。
- workplace1 测试会话 `session-e3ddc673-3bb2-47e9-9200-b351ce9094a4` 已有真源记录，归属 `workspace-joined-e570b6cb5ad738d6ce5d8f32860547b0`。
- “计算机四大”新会话 `session-1596eacd-f815-4c3d-85df-895b8f17c2ac` 原生记录完整（28 条事件），但真源尚无对应记录。
- 两条用户测试会话原生文件与本轮备份逐字节相同，没有通过直接覆盖文件处理。
- 真实宿主仍在对齐请求中返回 HTTP 409，整体同步阶段 blocked，因而“计算机四大”新会话仍未回传。旧宿主 handler 只返回 HOST_SYNC_INCOMPLETE，当前证据不足以确定其内部失败阶段，不能将“已有会话未排空”的推测写成确诊。
- 已请用户通过 Launcher 正常停止并重新启动测试实例，再核对运行期回执；当前启动身份仍为 `e45678be-fece-4a20-adcf-8af8e6023f94`，未把用户未回复当成已重启。
- 勾选交互经组件测试验证，实际 UI 留给用户。完整双向同步仍未验收，重启后若仍拒写，应继续定位宿主屏障并提供明确的失败阶段，不能绕过写入权检查或强行改写文件。

## 证据

`D:/AI/DeepSeekHarness-Plugin/artifacts/lynn-adapters-20260922/workspace-sync-fix-20260922`

包含更新前维护配置/数据库、宿主 sessions/storages/plugin-data 备份、Engine 正常退出回执、新接入校验回执及 `verification.json`。报告仅保留身份、版本、计数与状态，不含令牌或会话正文。
