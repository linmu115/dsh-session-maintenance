# Adapter 安装与构建协议 v1

本页是已确认 AC-001/002/004/008 的实现合同。普通用户使用发行的稳定 adapter。适配其他版本或业务类型时，作者可借助 LLM 构建，仍须进行协议、格式及故障测试；不需要修改 Engine 的版本白名单。

## 安装目录与启停

将一个可信发行包放到 `STATE/adapters/<package-directory>/`，入口为 `maintenance-adapter.json`。目录发现只读清单，不执行第三方代码。包内入口必须是相对路径且真实路径不越界；重复 ID、非法格式或模块加载失败显示为诊断。

```json
{
  "protocolVersion": 1,
  "packageId": "sample-notes",
  "version": "1.0.0",
  "entries": [
    { "kind": "business", "id": "sample-notes", "namespace": "sample-notes", "engine": "lib/adapter.mjs" }
  ]
}
```

`adapter list` 查看，`adapter enable <id>` / `adapter disable <id>` 改变持久配置；线上可在看板的 adapter 目录操作。当前实行重启生效，不宣称任意代码可热替换。DSH 宿主入口需要同时通过 DSH 官方插件安装机制安装，复制到 Engine 目录不会自动修改任意实例。

启用的 Engine 入口导出 `adapter` 或 `default`。执行代码有 Node 进程权限，不是恶意代码沙箱；只安装可信包。Adapter 不拥有权威业务数据库、不选择真源、不直接修改原始业务文件、不接管进程和业务生命周期。仅通过合同传入的读写端口做转换；停用保留所有会话扩展对象。

## 业务类型：一个声明和一份实现

发行包同时提供 contracts 与 adapter-sdk 的 tgz，可在自己的开发项目中一起安装。构建后把 SDK/校验库一起打包到 `.mjs`，避免依赖作者的 monorepo 或本地 link。

```ts
import { defineExtensionDataAdapter } from '@linmu/dsh-session-adapter-sdk'

export const adapter = defineExtensionDataAdapter({
  namespace: 'sample-notes',
  label: '示例笔记定位',
  pluginVersions: ['1.0.0'],
  schemaVersions: [1],
  capabilities: { read: true, write: true, delete: true, restore: true, panel: true, context: false },
  validate(content) {
    if (content.schemaVersion !== 1 || !content.body || typeof content.body !== 'object' || Array.isArray(content.body)
        || typeof content.body.ownerSessionId !== 'string' || typeof content.body.path !== 'string') {
      throw new Error('Unsupported note locator')
    }
  },
  ownership(content) {
    const body = content.body as { ownerSessionId: string }
    return { ownerSessionId: body.ownerSessionId, kind: 'note-locator' }
  },
  summarize(body) { return String((body as { path: string }).path) }
})
```

公共 `ExtensionContent` 是 `{schemaVersion,title,body,references}`。写入还需 `{scope:{instanceId,profileId,namespace},objectId,writerId,expectedRevision,content,deleted}`。Engine 统一负责身份范围、修订比较、冲突记录、分页和持久事务；adapter 负责自己类型的校验、所属会话与展示转换。重复操作和冲突不能用“覆盖最新文件”代替。`context:false` 表示 adapter 不授予模型读取上下文；上下文授权经过 Core。

核心类型来自 contracts 的 `ExtensionDataAdapter` / `ExtensionContent` / `ExtensionWrite`；SDK 不复制另一套 DTO。`validate`、`summarize` 必需；`ownership`、`preview` 和原生扩展事件校验按需实现。插件向 DSH 接入插件声明自己真实的 namespace、版本、writerId，调用统一扩展读写入口。只配置清单不会替代插件侧同步代码。

Core 的数据命名空间为 `annotation-upstream`、`annotation-records`、`annotation-context`；Bridge 为 `obsidian-links`；Sticker 为 `stickers`。可同包交付，独立启停和归属不合并。DAG 自己校验及执行图增删，保存通过会话数据接口；本轮不另改 DAG Maintenance adapter。

## 实例类型：同一交付包的两个入口

```json
{
  "protocolVersion": 1,
  "packageId": "my-dsh-adapter",
  "version": "1.0.0",
  "entries": [{ "kind": "instance", "id": "my-dsh", "engine": "lib/adapter.mjs", "worker": "lib/rpc-worker.mjs", "dsh": "lib/index.js" }]
}
```

DSH 入口是正常 DSH 插件，提供本实例连接、版本检查、配置和打开独立完整看板的入口。Engine 入口执行离线解释和运行数据格式转换。两者同包，不要求同进程。

Engine 实例对象遵循 `DshSessionAdapterV1`，用 `defineDshSessionAdapter` 声明。`manifest` 指明 `adapterApiVersion:1`、ID、发行版本、`testedDshVersions`、声明范围与能力。`probe` 必须检查实际环境，不凭版本字符串直接通过；会话解码、原生投影、追加、恢复、稳定引用解析遵循 SDK 的 DTO。`worker` 实现 `AdapterHost` 的 RPC 协议；参考同版本公开的标准 adapter 与 conformance 测试，不写绕过 Broker 的私有提交路径。

`runtime` 提供 `createBridge(registrar)`、`recoverTail(input)` 和可选 `bindAppend(operation,run,reader)`。它们只处理格式及已有端口的连接；Engine 负责租约、排空、回执、权威提交和恢复策略。不能在 adapter 中自行 spawn/kill 实例。

自定义独立宿主可提供 `hostIntegration.inspect(config)`，返回合同 `DiscoveredIntegration`：实际路径、插件/运行能力、构件指纹、匹配的 adapter ID 及诊断。登记配置中显式指定 `adapterId`。模块未启用、缺少检查接口或返回其他实例身份时拒绝接入；不会回退到另一个内置版本。`probe` 仍须独立通过。当前通用 CLI 采用 DSH 官方 CLI 的 `--patch` / `--profile` 启动约定；改变此启动协议的宿主需要新的正式启动接入实现，不能只放宽版本范围。

标准 DSH 0.1.5-rc.2 插件附带 `lib/verify-installation.mjs`。其构建同时包含 Engine codec/worker 和宿主材料检查信息，检验实际公开 persistence/handle 能力后生成本机回执。回执绑定本机实际文件，因此不能随发行包预制一个“全机器通用通过”的回执。

## Core 扩展口与最小依赖

业务插件用 `dsh-annotation-core/host-api` 的 `AnnotationCoreHost.registerSourceAdapter` 注册自己的 `extension:<providerId>`。来源身份包含 providerId/objectId/revision 和所选文本摘要；选中文本不因注册被替换。只有固定、可验证的选区快照可提交。移除来源 adapter 不删除已有引用，但不能再用缺失的 adapter 伪造来源验证。

`SessionReferenceContext` 提供目录、固定来源、授权、分页读取和状态；Core 使用本地会话实现，可由 `sessionReferenceContextProvider` 注入同合同的实现。Core 不按服务名称识别 Maintenance。曾进入受管状态后丢失提供方会拒绝写入，不静默回退到独立写入。

`SessionExtensionData` v1 提供 `get/list/write(expectedRevision)`，按 sessionId/namespace/objectId 分区，含删除标记。DAG 只通过该端口操作图，不创建私有图数据库。插件若另有业务数据，其业务合法性依旧由该插件校验。

第三方接入应覆盖：未知 schema/缺失 adapter、来源固定版本与授权边界、修订冲突、重复操作、停用后数据保留、运行中断连、恢复时未完成操作、正常收尾。Launcher Hook 和新格式 adapter 属于可借助 LLM 的开发工作；安装现有发行包和日常连接不依赖 LLM。
