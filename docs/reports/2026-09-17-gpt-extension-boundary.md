# GPT 插件扩展数据职责纠正（2026-09-17）

用户指出：高级设置中的 Harness Adapter 适配宿主实例会话迁移，GPT 插件属于扩展数据。此前将新增 checkpoint/replay 事件等同于新 Harness 的判断错误；本轮撤销独立 GPT Harness 注册和启动路由。

## 实现

- 将独立 Harness 包改为 `@linmu/dsh-session-extension-gpt-compat`，在扩展数据注册 `gpt-compat`；由 ExtensionDataAdapter 声明插件语义与归属。
- 宿主保留 dsh-0.1.5 / dsh-0.1.5-v3-jsonl-zstd-v1。受信插件 codec 组合进宿主，原始事件、加密字段、序号与引用完整保留，不替换全局依赖。
- 新事件标记 extensionNamespace；历史误建的 adapterId/formatId 不被改写，保留来源和旧 run 审计，并兼容读取。
- 已提交版本建立只读摘要索引，按实例/Profile/会话归属展示；不向扩展正文复制加密载荷，不接受通用写入。
- Launcher 按已验证插件报告扩展连接，与其它业务插件合并；Core 回执以 extensions 声明插件，宿主身份保持不变。
- 地图合同从“插件新增事件必须新建 Harness”纠正为“先构建扩展数据 Adapter”。开发历程 HIST-gpt-extension-boundary 保留误解及用户反馈，公开事件仅保留来源定位与指纹。

## 验证

聚焦测试覆盖宿主 V3、插件事件往返、Runtime Broker、Core 绑定、扩展目录、扩展数据、实例发现、外部生命周期和回执，共 152 个不同测试用例。首次回归中的旧身份断言与旧 worker 构件已更新，相关用例重新通过；没有用跳过断言规避错误。

Engine 与插件 TypeScript 检查通过。发布包保留一个 DSH V3 worker，未打包 GPT Harness worker；portable 检查覆盖 40 个构件文件。

## 部署

目标限定 0.1.5-rc.2 副本 / web。候选版本 Engine 0.1.33-rc2.30 / 插件 0.2.26-rc2.24。当前阶段源码和发布包验证完成；实际安装、绑定与启动验收结果将在下方追加。主实例和其它插件保持原构件，升级前后核对文件指纹。


### 副本安装与运行验收

已安装 Engine 0.1.33-rc2.30 / 插件 0.2.26-rc2.24，19 项构件重新生成回执，repair 返回 connected、无问题。Core 回执保持宿主 ID/format，加 extensions=[gpt-compat]。用户启动副本后，run-cadef66e-7ab5-4261-a5c8-089fa7e3b650 为 running，adapter_id=dsh-0.1.5。

运行前后 50 个会话；49 个已有身份保留，1 个零轮次、无标题和待办的空白启动占位会话由同目录的新空白会话替代。原 GPT 验收会话的 50 条事件前缀逐项相等。实际 Core probe compatible、六项能力可用、issues=[]；其它插件及主实例 1097 项文件指纹一致。

真实看板 API 的 Harness 列表为 dsh-0.1.5 / dsh-alpha2 / dsh-rc1 / dsh-rc2，没有 GPT Harness。扩展面板 GPT 兼容插件 ready，包含 1 个所属会话索引、0 冲突；当前数据是 5 次请求投影，检查点和两类压缩计数均为 0，未虚构压缩记录。详情返回 7 行预览，未包含 encrypted_content。

页面按业务面板 API 动态呈现，无 GPT 隐藏白名单。浏览器自动化连接本轮不可用，因此完成的是实际运行接口和前端数据路径核对，没有声称截图验收。未新增消耗 API 配额的模型调用；本轮验证的是适配职责、数据保存和恢复。

本机备份、完整回执与验收结果位于 GPT 项目的私有 artifacts/gpt-extension-upgrade-20260917，不提交真实会话或密钥。
