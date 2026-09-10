# 可拔插扩展数据接入

Engine 0.1.31、Maintenance 插件 0.2.24、数据库格式 22。

## 数据与身份

Maintenance 在现有数据库中增加 `extension_connections`、`extension_objects`
和 `extension_conflicts`。对象唯一键为 `(instanceId, profileId, namespace,
objectId)`，写入权由首次登记的 `writerId` 持有。换实例、profile 或命名空间
不会覆盖同名对象；跨实例共享需要另外显式设计，当前不自动合并。

每个对象包含 `schemaVersion`、标题、JSON 正文和稳定引用，更新版本由 Engine
生成。引用形式为 `{ logicalSessionId, messageId?, anchorId?, sourceVersion? }`，
一个对象可关联多个会话。这里的身份由接入方通过 Maintenance 现有会话解析接口
获得，不能用临时 runId 或原生目录名替代；不存在的外部引用不触发自动建会话。

图对象的边不构造会话版本双亲，不写入 `canonical_events`。既有 Annotation、
Sticker 和 Obsidian 历史事件照常保留，其迁移不属于本次公共接口实现。

## 两端 Adapter

DSH 版本 Adapter 的注册、兼容性和启用状态保持原样。扩展 Adapter 使用
`packages/contracts/src/extension-data.ts` 的 `ExtensionDataAdapter`：声明命名
空间、支持的插件/schema 版本和读写/删除/恢复/面板能力，提供格式校验与摘要。
`context` 本阶段固定为 false，不会提供模型请求材料或创建上下文快照。

Engine 侧可信代码可通过 `engine.extensions.register(adapter)` 注册，返回的
disposer 只卸载代码，不删除数据。也可以通过 `CompositionOptions.extensionAdapters`
给嵌入式 Engine 提供完整注册列表。此入口不接受浏览器上传并执行代码。
内置 v1 Adapter 使用以下数据形态：

| 命名空间 | 声明的插件版本 | 对象正文 |
|---|---|---|
| thoughtdag | dsh-thoughtdag 0.4.11 | ThoughtDAG 的 nodes / edges；保留其余字段，检查唯一 ID 和边的端点 |
| annotation | dsh-annotation-core 0.3.6 | ReferenceSet v1：setId、profileId、sessionId、state、revision、items 等 |
| obsidian-links | obsidian-deepharness-bridge 0.3.23 | 新接入用的链接 DTO：vaultId、notePath、可选 blockId、links、syncState、可选 sourceVersion |

版本声明和合成格式测试不代表已修改、安装或自动接管这些第三方插件。ThoughtDAG
目前仍有自己的浏览器 IndexedDB 保存入口；接管时必须修改该入口来调用下述保存
协议，不能只扫描 DSH 日志。Obsidian 表中是链接 DTO，不是现有插件数据文件的原样
迁移格式；Vault 仍拥有笔记正文。已有 ReferenceSet 自带的选区内容可以作为当前
对象保存，本实现不会额外采集或复制整份笔记。

未知 schema 版本明确拒绝正文读写，元数据仍可列出；升级 Adapter 时应提供明确
格式迁移并进行带预期版本的保存，不能让核心猜测或强制降级数据。

## DSH 宿主接入

在当前 Maintenance 插件的 profile 配置中显式声明参与接入的插件：

```yaml
extensionPlugins:
  - namespace: thoughtdag
    pluginVersion: 0.4.11
    writerId: dsh-thoughtdag
  - namespace: annotation
    pluginVersion: 0.3.6
    writerId: dsh-annotation-core
```

此配置是该实例/profile 的完整接入名单。使用 `extensionPlugins: []` 明确断开
全部扩展；省略字段维持旧版不参与扩展接入的启动方式。真正卸载业务插件时需同步
更新此名单，不能只卸载包而保留旧声明。兼容报告由 Maintenance 保存，面板中的
“停用”偏好不会被下次报告覆盖。

Maintenance 原生会话运行模式接入后提供 Cordis 服务
`ctx.maintenanceExtensionData.bridge`。业务宿主插件声明对该服务的依赖，通过
自己的授权路由转发画布或注释编辑；Engine 凭据保留在宿主，不能交给浏览器。

```ts
// 业务插件宿主代码。需在上面的 profile 名单中声明 thoughtdag。
const bridge = ctx.maintenanceExtensionData.bridge;
const page = await bridge.list('thoughtdag'); // 每次 30 项元数据，无正文
const next = page.nextCursor
  ? await bridge.list('thoughtdag', page.nextCursor) : null;
const saved = await bridge.get('thoughtdag', canvasProjectId);

const result = await bridge.save(
  'thoughtdag',
  canvasProjectId,               // 稳定项目 ID；新对象用 expectedRevision = 0
  saved.object.revision,
  {
    schemaVersion: 1,
    title: canvasName,
    body: { nodes, edges },      // 实际保存时保留业务插件需要的其余字段
    references: [{ logicalSessionId }],
  },
);
if (result.status === 'conflict') {
  showConflict(result.conflict); // 两份内容保留，不能显示“已保存”
} else {
  markSaved(result.object.revision); // saved 或相同内容的 unchanged
}
```

调用方必须保留未获确认的编辑。网络失败或超时后可以重试同一内容；当前状态与
传入内容相同时，不增加版本，也不产生备份。收到新版本后，下一次编辑携带该版本。
浏览器缓存只是待提交状态，不再拥有另一个可以无条件覆盖 Maintenance 的真源。
对象的删除/恢复通过同一 save 接口的最后一个 `deleted` 参数提交；恢复需先明确
读取已删除对象的当前版本。

## Engine 客户端接口

`MaintenanceClient` 与 `DashboardClient` 提供以下方法，所有路由沿用 Engine
已有的 Bearer 或 UI 会话/CSRF/Origin 检查：

| 客户端方法 | 路由 |
|---|---|
| listExtensionPanels | GET /v1/extensions/panels |
| connectExtensions | POST /v1/extensions/connect |
| enableExtension | POST /v1/extensions/enabled |
| listExtensionObjects | GET /v1/extensions/objects |
| getExtensionObject | GET /v1/extensions/object |
| writeExtensionObject | POST /v1/extensions/write |
| getExtensionConflict | GET /v1/extensions/conflict |
| resolveExtensionConflict | POST /v1/extensions/resolve |

目录支持 limit（1–100，默认 30）、after 游标和 active/deleted/all 筛选。正文只在
打开对象或指定冲突时读取。停用、缺少 Adapter 或版本不兼容时保留通用元数据访问。
对象正文和冲突的读写必须通过相应能力检查。

冲突处理入口要求当前版本：`current` 放弃本条候选并保留当前状态，`incoming`
以新版本采用传入编辑。如果对象又被编辑，操作拒绝，用户必须重新查看。需要手动
合并时可在对象编辑区保存合并后的内容，再明确放弃相应候选；核心不自动合并图。

## 容量与维护

- 每个对象只保存当前状态和当前更新版本，删除保留当前正文用于恢复。
- 相同内容不增加版本；JSON 键顺序变化不构成编辑。
- 每个对象最多保留 16 条未处理冲突，同一冲突重试复用记录；到达上限后拒绝新的
  冲突写入，调用方保留本地候选。明确解决后删除这条冲突记录。
- 单个正文连同标题、schema 和引用最多 512 KiB；更大的业务图需要接入方按稳定
  对象 ID 拆分并另外设计跨对象提交，不能静默截断。HTTP 写入上限为 600 KiB。
- 不按模型轮次、刷新页面或渲染动作保存材料副本；不新增上下文快照仓库。
- 当前没有自动清空扩展回收站或永久删除功能。SQLite 空闲页由既有数据库维护
  管理，不宣称每次删除冲突都会立即缩小数据库文件。

数据库升级为格式 22 后，旧 Engine 不能直接打开它。副本升级和任何回退应沿用
维护系统的停止、迁移与验证流程，不能只替换二进制后丢弃新表。
