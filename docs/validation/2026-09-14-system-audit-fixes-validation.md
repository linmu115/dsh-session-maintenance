# 0.1.5-rc.2 副本：系统审计问题修复与验收

日期：2026-09-14。范围为前次系统审计的 F01–F11。本文由实际构建、回归、安装回执和界面检查汇总；真实模型回答质量及真实 Vault 迁移不以合成测试代替。

## 修复映射

| ID | 修复后的行为 | 验证依据 |
|---|---|---|
| F01 | 旧发送请求回执不确定时，重试先恢复旧请求状态；若文字、附件或引用已经修改，使用新的提交标识发送，不再错误消费新草稿。 | Core 普通/带引用草稿、附件和修订测试；原审计失败用例现已通过。 |
| F02 | 全局维护网络将当前实例的原生会话 ID 传给宿主导航；无效 ID 在查询前被拒绝。 | ThoughtDAG 真实 SPA/iframe/宿主桥接的合成浏览器验证，以及更新后副本导航检查。 |
| F03 | 初始引用预算扣除已有上下文、本轮输入、系统/工具封装和输出预留；Codex 使用自身真实请求封装计数。容量信息不可确认时使用有标识的保守总上限，不把它当成真实剩余额度。 | Core 与 Codex Runtime 专项回归，包含版本、配置、会话摘要失配和完整封装大小边界。 |
| F04 | 迁移激活必须与阶段回执中的完整对象集合、对象内容和待删除双链一致；只提交集合一部分或篡改内容会失败。 | 规范化清单摘要、篡改、重复激活、激活后合法编辑与旧回执兼容测试。 |
| F05 | 引用执行额度由 Maintenance 持久管理，执行结束和运行收尾回收记录；运行内结束标记防止重放重新充值。 | 超过 10005 次执行、持久重启、结束标记和运行关闭清理测试。 |
| F06 | 无变化启动先核对摘要与资源收据，跳过未变会话正文；资源缺失或损坏仍会检查并修复。 | 官方 RC2 207 会话两次独立冷读；第二次准备阶段正文读取 0，原生文件哈希、时间和大小不变。 |
| F07 | Obsidian 选区可创建或挂接真实会话贴纸；贴纸展示有界摘录并可打开来源笔记，会话入口仍打开完整会话页。 | Companion 选区/保存/重试/取消测试；Sticker 合成浏览器的来源按钮、会话导航及显示测试。 |
| F08 | 旧 Annotation 打开来源时先按稳定块标识解析当前笔记位置，覆盖移动、改名和旧路径被其它笔记占用；歧义与缺失明确报错。 | 路径移动、旧路径复用、重复块和缺失块测试。 |
| F09 | 删除和改名触发同步；大量链接按持久游标分批继续，不再卡在前 600 条；同步采用修订检查，旧结果不能覆盖刚完成的修改。 | 长列表、失败重试、游标恢复、修订冲突、实例切换和串行写入测试。 |
| F10 | 固定图谱材料在来源追加后仍能展开尚存在的旧版本，保持原截止范围；旧版本已清理时明确不可用。 | Maintenance 固定版本边界及 ThoughtDAG 浏览器测试；未新增逐轮正文备份或版本保留锁。 |
| F11 | 全局维护网络包含独立引用，可按引用文本/标题搜索并查看会话的入向与出向关系；来源影响只供用户选定后准备草稿。 | 网络聚合、分页、撤销/删除/作用域测试及 ThoughtDAG 实际界面结构测试。 |

## 设计边界

- 引用默认提供被选中回复所在的问答上下文；继续向上游读取仍由工具按需执行，范围不超过固定完成点。
- Obsidian 选区会话贴纸表示关联，不会因为建立关联就自动发送模型请求；普通“引用到 DSH”仍是单独入口。
- 笔记正文由 Vault 管理；此次不创建逐轮全文快照，不复制完整上游历史。
- 影响传播采用“标出受影响会话，由用户选择后重新回答”；不会自动发送或重新运行关联会话。
- 迁移的新回执只增加清单摘要。旧 active 回执无摘要时仅返回原有回执并标记 `legacy-receipt-only`，不写入新对象，也不声称已经验证当年的完整内容。
- 207 会话验收是一个合成场景，分别启动两次官方 RC2；不能算作 414 个独立测试。退出 checkpoint 的正文读取与无变化启动优化是不同阶段。
- 初始引用准备期间若切换模型、改变会话状态或工具能力，提交前的本地核对会拒绝沿用旧预算并保留草稿。该异步边界经过独立源码复核及延迟查询合成测试；校验阶段不再次查询模型服务。

## 尚需用户业务验收的范围

自动检查没有发送真实模型请求，没有移动/删除真实笔记，没有执行真实 Vault 迁移。长上下文下模型实际工具使用、已有复杂 Vault 的人工迁移结果和其它历史 DSH 实例仍需各自业务验收。它们不代表 F01–F11 的已知缺陷仍未修复，也不能据此宣称整个系统所有场景已经获得完全证明。

## 部署与结果

**结论：F01–F11 均已修复、本地提交，并安装到 0.1.5-rc.2 副本。副本目前正常运行。** 未推送远端。

当前实例：i-7ecb6c19-80a5-4c2e-97e6-484bbfc0e926 / web。运行地址：http://127.0.0.1:46347；运行记录：run-263467d2-04c0-4e18-a65e-e48cd1b9a2e3。

| 检查 | 实测结果 |
|---|---|
| 官方 CLI 安装与严格依赖 | 19 个插件，12 个包升级，实际安装的 1010 个打包文件逐项哈希一致 |
| 官方 RC2 配套宿主 | 新组合的写入、冷读、Core binding、读写 handle 和上游目录探针通过；所有写入均在合成目录 |
| Engine 与真源 | Engine 0.1.33-rc2.14，schema 23，quick_check=ok；530 个会话 head 摘要与升级恢复点一致 |
| 本次运行 | 只有副本的新运行记录；待提交、失败提交、未结束提交阶段、任务队列与 WAL 均为零；没有新增隔离记录 |
| 主实例 | 三份 profile 文件哈希不变，Maintenance 接入仍 connected |
| 扩展面板 | annotation-upstream、stickers、obsidian-links、thoughtdag 全部 ready |
| 实际网络界面 | 独立引用搜索、入向/出向关系、引用目标跳转、原网络会话列表跳转全部通过 |
| 开关位置 | 对话、思维图、返回对话三个状态的 x/y/width/height 一致 |
| Companion | 已正常停用、替换文件、刷新清单并启用新版；运行版本已验证，替换阶段 data.json 与 knowledge.json 字节不变 |

### 验证计数

| 组件 | 最后一轮完整测试通过数 |
|---|---|
| Annotation Core | 176 |
| Sidechat | 101 |
| Obsidian Lifecycle | 34 |
| Reference Adapter | 30 |
| Session Sticker Board | 102 |
| Obsidian Companion | 217 |
| Reference Suite | 12 |
| Codex Runtime | 32 |
| ThoughtDAG 基础测试 | 36 |

上表七个界面/引用仓库合计 672 项完整测试。Maintenance 的 46 项专项与 30 项发布相关回归全部通过，两组有重叠，后续完整迁移清单补强测试另行通过，不合并虚报独立总数。ThoughtDAG 另有 10 项真实 SPA/iframe/宿主桥接合成浏览器检查，Sticker 另有 8 项合成浏览器检查。相关仓库类型检查、构建与打包通过。

207 会话官方 RC2 验收用的是相同 F06 实现的前一打包提交 72c8495；最终 06d7ff4 只追加迁移清单补强，未改该原生目录实现。该场景的首次准备约 4011 ms、无变化第二次约 239 ms，仅为这组小型合成数据的本机观察，不是对真实会话数量或耗时的承诺。

### 当前迁移边界

新会话贴纸面板已经加载，但真实的新 stickers / obsidian-links 对象列表目前为空；不能把空面板代替真实建卡和迁移验收。旧注释贴纸仍遵守既有迁移门禁：没有有效 active 迁移回执时，旧加载链会输出“请先迁移此会话的旧贴纸”。这不证明会话一定存在旧贴纸，未迁移且无旧对象也可能出现同样提示。初始未登记会话还会有一次旧加载身份检查警告。两条均来自旧加载链，新的 kind=session 面板不依赖该回执；本轮未替用户执行迁移或选择冲突版本。

浏览器验收没有发现新运行地址的 error 级日志；上述两条 warn 单独保留在 UI 记录中。旧地址停机重连日志不算新版本故障。

### 安装版本

| 包 | 版本 |
|---|---|
| @evylynn/dsh-sidechat | 0.4.7-rc2.7 |
| dsh-agent-teams-adapter | 0.1.0-dev.6 |
| dsh-annotation-core | 0.3.12-rc2.7 |
| dsh-codex-runtime | 0.2.0-dev.17 |
| dsh-obsidian-bridge-lifecycle | 0.3.3-rc2.11 |
| dsh-obsidian-reference-adapter | 0.3.4-rc2.11 |
| dsh-obsidian-session-reference-suite | 0.3.4-rc2.12 |
| dsh-runtime-support | 0.1.0-dev.9 |
| dsh-session-dispatch | 0.1.0-dev.5 |
| dsh-session-maintenance | 0.2.26-rc2.10 |
| dsh-session-sticker-board | 0.7.3-rc2.12 |
| dsh-thoughtdag | 0.4.14-rc2.5 |
| Obsidian Companion | 0.6.4-rc2.5 |
| Maintenance Engine | 0.1.33-rc2.14 |

### 本地代码提交

| 仓库 | 提交 |
|---|---|
| dsh-session-maintenance | 06d7ff47b1669e39faca45098bf29eb6521cd934 |
| dsh-annotation-core | 7202899a5fda5d6c41ab34a5d3de226b7bd79b47 |
| dsh-codex-runtime | 2178b013c44014b706d9becb0700aa316a44321a |
| dsh-sidechat | 64e802888c384382044af26f15809811d6745384 |
| dsh-obsidian-bridge-lifecycle | 8eb054a84a07b0d21ee4c1d94aa2ca1648fdc03d |
| dsh-obsidian-reference-adapter | cc5259883b5b8a23cecfceffed7afabcffc0f2bf |
| dsh-session-sticker-board | 12d973347080115823b1c461b4bed74f4aed6cbb |
| obsidian-deepharness-bridge | 6be5e6f359ec2b396f1599a30d4147143eb48284 |
| dsh-obsidian-session-reference-suite | 76f2c44b4050530c22ff20ababa7ce0690286981 |
| thoughtdag | e2ce52b82753db1074a8ed80d284f8d0d773bf67 |

上表记录发布代码提交。本文的后续本地提交只添加验证文档，不改变安装包代码或配套收据。

### 原始结果

- [copy-installation-final.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/copy-installation-final.json)
- [installed-files-verification.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/installed-files-verification.json)
- [host-probe/result-final.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/host-probe/result-final.json)
- [engine-handoff-final.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/engine-handoff-final.json)
- [copy-binding-final.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/copy-binding-final.json)
- [post-deploy-state.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/post-deploy-state.json)
- [live-validation.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/live-validation.json)
- [live-ui-validation.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/live-ui-validation.json)
- [companion-runtime.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/companion-runtime.json)
- [final-source-commits.json](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/final-source-commits.json)
- [207 个会话的官方 RC2 验收](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/rc2-large-native/report.md)
- [Maintenance 修复报告](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/maintenance-fixes.md)
- [全局网络界面截图](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/network-live.png)
- [会话贴纸界面截图](D:\AI\DeepSeekHarness-Plugin\artifacts\system-fixes-20260914/stickers-live.png)

只保留本次 schema 升级的一次已校验数据库恢复点和替换前插件文件。它们是部署恢复材料，不是逐轮上下文快照。
