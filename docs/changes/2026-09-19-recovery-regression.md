# Launcher 升级回归与扩展目录请求失败

2026-09-19，用户报告扩展左侧无工作区（HTTP 431），随后报告 Launcher 无法启动副本；明确 431 截图来自外部浏览器。

## 原因与修复

- `.45` 构建分支遗漏已安装过的 `b7af3b8` 启动恢复补丁。Launcher 调用 `recoverBeforeStart` 时 Provider 不识别请求，返回非协议 JSON，trace 记录 exit=1 invalid-json。已将原补丁合入当前分支，保留正式恢复、退出证据及进程身份登记。
- 内置浏览器在 DSH 停止时，三个 Adapter 的目录请求均为 200，因此工作区读取不依赖实例在线。外部浏览器的原始 431 未抓取成功：Edge 已被发现，但标签枚举与直接连接均失败，不能宣称所有浏览器不可用。
- 本机 Cookie 按主机而非端口共享；合成的约24KiB其他本机 Cookie 复现默认请求头上限这一触发条件。Engine 将请求头额度显式设为64KiB，仍保留上限、Origin、Cookie和CSRF校验，不清理其他程序Cookie。此为已验证的431兼容处理，外部原始失败页是否完全恢复尚未视觉确认。
- 目录加载、空结果、失败、成功分开显示。失败时左侧可重试，右侧不再要求展开未加载的目录；431提示与实例是否启动无关。

## 验证与实际安装

Engine `0.1.33-rc2.46`、Dashboard `0.1.9`。恢复/Provider24项、目录5项、UI会话2项、构件验证1项共32项通过；Engine与Dashboard类型检查及前端构建通过。运行实际打包入口的合成recoverBeforeStart通过。

备份配置、回执和数据库，确认无活动run/job，正常SIGINT停止并核验drain/owner-release后切换。安装脚本第一次遇到PowerShell回执UTF8 BOM，修复读取后继续；第一次激活又被遗漏的.46回执版本枚举拒绝，补齐枚举并通过现有当前版本测试后正常停止、重建、启动，正式repair成功。两次失败均保留在来源索引中，没有绕过校验。

实际正式Start已通过recoverBeforeStart→prepare→started，目标副本及Maintenance run均running；run为`run-ce3d9ad4-db97-4df9-876e-4d4b561279ce`。更新后1166个已安装插件文件哈希保持一致，Vault配置、profile及同步策略不变。安装证据存于本机`D:/AI/DeepSeekHarness-Plugin/artifacts/recovery-regression-20260919`。

内置浏览器已实测工作区→会话→条目展开；没有修改扩展内容或真实Vault绑定。通过桌面脚本链请求默认浏览器打开新登录入口；外部浏览器视觉与原始431复测仍未验收。Launcher恢复进度动画未验收。
