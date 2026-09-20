# Maintenance 交接与后续开发、插件独立验收

## 最新任务方向

用户要求先登记 Maintenance 复杂改动并暂停该部分开发。优先关闭引擎，验证 Core、DAG、两侧 Bridge、普通贴纸独立工作能力；新阻断仍在对应插件停止并报告。
本文件及 ../issues/2026-09-20-managed-plugin-composition.md 替代此前部署报告中“普通插件变化应阻断、用户每次 revalidate”的后续建议。历史证据仍保留。

## 已完成与现场起点

提交 25299ef：兼容判断改为 adapter 接入协议、宿主、格式及能力声明；42 项测试通过，实际 .36 注册/启动/DAG 保存刷新/正常停止通过。
发行目录：D:/AI/DeepSeek-Harness/session-maintenance-compatibility-20260920（candidate-r8）。
Engine .58；接入 .36；Core .21；DAG .17；DSH Bridge .4 已安装；testvault Companion .5 已安装启用并保留原绑定、历史；Sticker .6 尚未安装。
测试实例 ID：i-27c4d5a7-bdb5-4b8a-8d95-6267f47499c5；profile web。
DSH Home：C:/Users/19717/AppData/Roaming/in.dsh-plug.dsh-launcher/homes/0.1.5-rc.2 测试。
DSH runtime：C:/Users/19717/OneDrive/文档/ChatGPT/dsh/.artifacts/rc2-launcher-deployment/runtime。
Maintenance state：C:/Users/19717/AppData/Local/DSH-Session-Maintenance。
有效维护库：metadata.projects-20260906-0-1-19.sqlite；不要误用同目录 metadata.sqlite。
Vault：D:/obsidian/testvault；不得更改其他 Vault。
受管目标：dsh-0a1ff7d0adab3684267dd4695fef1b7f；勿操作 Launcher 发现的另一同名目标。

## 转独立模式

先确认已正常停止且 finalReceipt=closed，再通过 managed-instance unregister 正式解除此目标。
按教程将 sessionSource 切为 native；为证明其他插件不依赖 Maintenance，再停用/移除 DSH 接入插件，保留配置备份和维护历史。
正常关闭引擎，不删锁、不强杀。直接用 DSH 官方 CLI 启动 web，在 Codex 内置浏览器展示页面。
使用明确标识的本地测试会话验收；受管投影与普通本地数据目录不会自动合并，不复制底层会话文件假装完成迁移。
业务数据 adapter 同步在本阶段不启用，Codex 不处理。

## 独立验收范围

- Core：本地选文/引用登记、待发送引用；模型实际发送由用户最终验收。
- DAG：本地会话图显示、合法操作、保存、重开；只需 Core。
- Bridge/Companion：引擎关闭时，DSH 设置页发现并连接 testvault；验证断开/重新连接，历史保留；无 CLI 是另外的可选能力用例。
- Sticker：安装在 Core + Bridge 后，创建、保存和重开本地测试贴纸。
- 记录实际安装版本及引擎确实关闭。源码存在可选 Maintenance 接口不等于硬依赖；不得仅据源码候选宣称全体已验收。

## 后续 Maintenance 开发顺序

1. 将普通插件/非关键配置与接入关键合同分离，明确适配层只向引擎给出必要检查结果。
2. 为普通插件新增/移除/升级、无 adapter 新类型、关键合同真实失效建立合成用例；普通插件变化必须可启动，核心不兼容要有具体诊断。
3. 完成未知数据全链路审计和无损往返测试；缺 adapter 只影响专用理解功能。
4. 验证断连停写、恢复、正常退出和解除注册保护仍有效。
5. 最后决定是否需要诊断性的 revalidate，再补完整用户教程；不能以新增命令替代前面边界修正。

## 本轮执行结果

结果见下文。遇到新插件阻断按用户要求停止，不扩展成未授权重构。


## 实际执行结果（2026-09-20）

- 正式 unregister 成功；随后移除 DSH Maintenance 包和 bundle，接入配置保存在 before-independent-acceptance 备份中，原维护历史保留。
- Maintenance 引擎正常退出，42831 无监听；DSH 用官方 CLI 直接运行，无 Launcher Hook 和 Maintenance 进程。
- Core .21、DAG .17、Bridge .5 当前安装；testvault Companion .5 启用。
- 用户指出 Obsidian 连接设置没有宿主样式；已在 Bridge .5 修复。浅色、深色实际截图复核通过，原“跟随系统”偏好已恢复；当前内容宽 491px，scrollWidth 同为 491px。更窄断点有 CSS 支持，本轮未额外覆盖尺寸验收。
- 在引擎关闭且无 Maintenance 接入插件时，从 DSH 设置页断开 testvault 成功，再连接成功，最终显示“已连接”。没有改动 math Vault 绑定。
- 主会话窗口在独立 UI .5 运行时已加载新会话页面，旧模型 cpa-native/gpt-6-astra 仍不可用。本轮没有调用模型，也没有完成新本地会话内的 Core 引用、DAG 图持久化验收。
- 继续安装 Sticker .6 后启动失败：dsh-session-sticker-board: pending (waiting for service: obsidianBridgeLifecycle)。版本核对无回退；属于贴纸/桥服务就绪的新阻断，未诊断为 Maintenance 耦合，未修改加载逻辑。
- 已通过官方插件命令撤回 Sticker 安装，恢复 Core + DAG + Bridge 可展示的基线。当前 DSH PID 48080，WebUI http://127.0.0.1:19876/；引擎继续关闭。
- 失败日志：independent-sticker.stderr.log；恢复日志：independent-ui-restored.stderr.log/stdout.log。日志含本机信息，分享前应脱敏。
- 当前仅可声明 Bridge 连接管理已通过无引擎真实操作；其他插件全功能独立性未全部验收。不得用“架构已解耦”代替此结果。

## 下一步

优先定位普通贴纸等待 Bridge 服务的加载顺序/服务可见性，再按 Core → DAG → Bridge → Sticker 的业务验收推进；仍不恢复 Maintenance 开发。Core 引用与模型上下文最终交用户验收。
