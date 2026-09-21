# 独立组件安装、配置与使用（2026-09-20 候选）

本教程对应 Engine 0.1.34-rc2.59、接入插件 0.2.26-rc2.36、Core 0.3.12-rc2.21、Bridge 0.4.1-rc2.5、普通贴纸 0.7.4-rc2.6、ThoughtDAG 0.4.14-rc2.17、Companion 0.7.0-rc2.5。它们是本轮源码候选，不表示已发布到 npm 或已安装到任何用户实例。标准宿主 adapter 针对 DSH 0.1.5-rc.2；不声称兼容任意 DSH。

## 选择组合

| 需要的功能 | 安装组件 | Maintenance / Launcher |
| --- | --- | --- |
| 选文、右键引用、上下文注入 | Core | 均不需要 |
| 会话图 | Core + ThoughtDAG | 均不需要；图保存到宿主会话扩展数据层 |
| Obsidian 跳转与双链 | Core + DSH Bridge + Vault 内的 Companion | 均不需要；Obsidian CLI 可选 |
| 普通贴纸 | Core + Bridge + Sticker | 均不需要 |
| 集中维护、历史与恢复 | 独立 Engine + 匹配的 DSH 接入插件 | Launcher 可选；注册后 Engine 必须在线 |

Companion 只与 Bridge 交接。一个 DSH 可连接多个 Vault，每个 Vault 同时只连接一个 DSH。断开连接不删除笔记、引用及双链记录。本轮不加入跨实例历史路由。

## 一、准备空环境和安装插件

使用 Node 24.7 或后续满足发行要求的版本，以及 pnpm 11。接入验证回执绑定实际 Node 和宿主文件，升级后必须重新检查。将发行目录解压到自己的程序目录；选择自己的 DSH Home 和 Maintenance 数据目录，三者分开。下例变量均由使用者填写，不依赖作者机器路径。

```powershell
$release = '<发行目录>'
$runtime = '<DSH程序目录>'
$env:DSH_HOME = '<DSH数据目录>'
$state = '<Maintenance数据目录>'
$engine = Join-Path $release 'engine/dsh-session-maint.mjs'
$dshBin = Join-Path $runtime 'node_modules/@deepseek-ai/dsh/lib/bin.js'
```

新装 DSH 时，在自己的程序目录安装固定版本；已有 DSH 则使用该安装的官方 CLI，不重复安装到旧目录。

```powershell
npm install --prefix $runtime '@deepseek-ai/dsh@0.1.5-rc.2'
node $dshBin --profile web --dump-config
```

第二条解析官方 `web` 配置，缺失时由宿主初始化。`web` 是自带名称，不与 `--from-default-profile web` 同用；该选项只用于另外命名的自定义配置。配置输出可能含个人信息，不要公开粘贴。DSH 自带组件与插件依赖还需由官方插件安装命令解析；网络不可用时应事先准备依赖缓存。

按上表只安装所需的包，以下以 Core 为例；包名在 `BUILD-INFO.json` 的 `packages` 中：

```powershell
node $dshBin plugin --profile web add (Join-Path $release 'packages/dsh-annotation-core-0.3.12-rc2.21.tgz')
```

随后安装 DAG，或 Bridge、Sticker。安装顺序为 Core → Bridge → Sticker，DAG 在 Core 之后。检查 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles`：应保留原来的官方 Web bundle，并包含刚安装的插件包名；某项尚未列出时在数组末尾手动补入，保留其他项目。插件的 `cordis.patch.yml` 随包提供，不需要用户手写插件内部对象。

独立使用至此可通过 `node $dshBin --profile web` 启动。DSH 的模型供应商、地址、模型 ID 和调用密钥仍在宿主设置中配置；Maintenance 不提供 CPA 密钥。出现 `No credential configured for LOCALGPT_API_KEY` 时，应为对应供应商填入凭据或配置该环境变量，并从具有该环境的终端重新启动；不能把 CPA 管理密钥当作模型调用密钥。不要把密钥写进本发行目录、回执或 Git。

## 二、Bridge 与 Companion

将发行目录 `unpacked/obsidian-deepharness-bridge` 中的 `main.js`、`manifest.json`、`styles.css` 放到每个需要连接的 Vault 的 `.obsidian/plugins/obsidian-deepharness-bridge/`，在 Obsidian 社区插件页启用。

在 DSH 的设置中打开 **Obsidian Bridge** 面板，发现并选择自己的 Vault，再执行连接。每条连接验证实例、Vault、启动身份和修订。Vault 已连到其他 DSH 时，先在该 Vault 的 Companion 设置中断开，当前 DSH 面板不提供全局抢占。

断开后历史记录保留；重新连接同一 Vault 后重新核验目标。没有 Obsidian CLI 时，基础桥继续运行，LLM 不会获得可执行的 CLI 工具。需要 CLI 增强时按 Obsidian 官方方式配置，再重新加载 Bridge；它不是基本功能的安装前提。

## 三、可选的 Maintenance 接入（无 Launcher）

先通过上面的官方命令安装 `dsh-session-maintenance-0.2.26-rc2.36.tgz` 并在 bundles 中启用。安装接入插件本身不等于注册。

初始化一次并启动 Engine：

```powershell
node $engine --state-root $state init --json
node $engine --state-root $state serve --host 127.0.0.1 --port 0 --json
```

保持这个终端运行。另开终端，重新设置上述变量。Engine 独立提供完整看板；DSH 接入插件的设置页负责连接状态及打开看板。不要把 `connection.json` 中的令牌复制到前端或说明文档。

无需启动 DSH 也可以获取看板的一次性登录地址，在自己的浏览器打开返回的 `launch.url`；链接过期后重新执行，不向他人分享：

```powershell
node $engine --state-root $state dashboard
```

准备 `instance.json`，将路径换成自己的绝对路径：

```json
{
  "schemaVersion": 1,
  "instanceId": "my-dsh",
  "profileId": "web",
  "name": "我的 DSH",
  "runtimeVersion": "0.1.5-rc.2",
  "homeRoot": "C:/MyDSH/home",
  "versionRoot": "C:/MyDSH/runtime",
  "runtimeUrl": "http://127.0.0.1:19876"
}
```

在 `profiles/web/cordis.patch.yml` 中配置本实例的接入身份和实际 Web 监听端口。合并到已有配置，不覆盖其他插件配置：

```yaml
- id: session-maintenance
  config:
    connectionId: primary
    dshInstanceId: my-dsh
    profileId: web
    sessionSource: maintenance
- id: webserver
  config:
    host: 127.0.0.1
    port: 19876
```

从已安装的插件执行检查。它在标记的临时目录中实际创建、追加、刷新、关闭并重开合成会话，不操作用户会话。回执必须在最终安装路径生成，移动构件后要重新生成。现有回执不会覆盖，先保留备份再重新检查。

```powershell
$profile = Join-Path $env:DSH_HOME 'profiles/web'
$verify = Join-Path $profile 'node_modules/dsh-session-maintenance/lib/verify-installation.mjs'
node $verify --config '.\instance.json' --engine $engine --engine-version '0.1.34-rc2.59' --out-dir $profile
node $engine --state-root $state managed-instance register --file '.\instance.json'
node $engine --state-root $state managed-instance list
```

本次标准安装检查不覆盖实验性 GPT Compat，若检测到该 bundle 会说明原因并退出；不伪造兼容回执。安装检查通过仍须完成下述业务验收。

启动受管实例，保持启动终端运行：

```powershell
node $engine --state-root $state managed-instance start --instance my-dsh --profile web
```

Engine 未就绪时启动失败并提示先启动 Maintenance。运行中断连会暂停新的发送、图和引用等持久修改，保留草稿及未确认数据；恢复连接后先补齐操作和回执，再恢复写入。不要删除注册文件、直接修改底层会话文件或改用另一份空库绕过该状态。

正常停止使用启动输出中的 `handle`，或在启动终端按 Ctrl+C 发起同一收尾流程：

```powershell
node $engine --state-root $state managed-instance stop --handle '<启动时返回的handle>' --runtime-url 'http://127.0.0.1:19876'
```

只有正常排空并取得关闭回执才结束；失败不会强制杀进程。上次异常退出后：

```powershell
node $engine --state-root $state managed-instance recover --instance my-dsh --profile web
```

Engine 自身异常退出遗留的状态应使用 `serve --recover-dead-owner` 核验恢复，不能手工删锁。解除注册前先正常停止实例，再执行下列命令，目标 ID 从 `managed-instance list` 获取：

```powershell
node $engine --state-root $state managed-instance unregister --target '<目标ID>'
```

仍有活动、隔离或待恢复运行时解除注册会被拒绝。成功后才把 profile 配置的 `sessionSource` 改为 `native` 并重启。解除注册不删除维护历史；原受管原生空间和普通 DSH 数据目录不是自动合并关系，需要保留已核验的导出/恢复结果后再决定独立运行的数据来源。

## 四、可选业务 adapter

发行包 `adapters/knowledge` 包含 Core、Bridge、Sticker、ThoughtDAG 的独立命名空间。首次部署在 Engine 停止时，将整个 `knowledge` 文件夹复制到 `$state/adapters/knowledge`。仅复制/发现不会执行模块；按需启用：

```powershell
node $engine --state-root $state adapter list --json
node $engine --state-root $state adapter enable annotation-upstream
node $engine --state-root $state adapter enable annotation-records
node $engine --state-root $state adapter enable annotation-context
node $engine --state-root $state adapter enable obsidian-links
node $engine --state-root $state adapter enable stickers
node $engine --state-root $state adapter enable thoughtdag
```

CLI 修改启停配置使用离线写入锁，Engine 正在运行时使用看板的 adapter 目录设置。启停后重启 Engine 和受管实例，停用不删除数据。命名空间安装但未启用时不会回退到内置同名实现。旧部署的内置 adapter 保留兼容；ThoughtDAG 的同步入口现通过统一会话数据接口接入，DAG 自身不调用 Maintenance 图存储。

还需在 DSH 接入插件的 `extensionPlugins` 配置中声明实际安装的成员，例如 `namespace: annotation-upstream, pluginVersion: 0.3.12-rc2.21, writerId: my-core`；同理可声明 `annotation-records`、`annotation-context`、`stickers`、`obsidian-links`。命名空间属于哪个插件，就填写哪个插件的真实版本。完整 DTO、启停及作者规范见随包 `ADAPTER-AUTHORING.md`。

## 五、Codex 与 Launcher 都是可选项

镜像同步、双向维护、后台常驻是三个独立设置，初始均关闭。同步页先检查实际 Codex 程序版本、目标目录及会话结构，通过后才允许启用对应能力；记住主动开启的选择，但每次启动和环境变化后重新检查。检查失败暂停对应能力，不阻断独立 DSH 和插件。当前 Codex reader 的已验版本为 0.146.0；未匹配版本应等待匹配 adapter，不能把“安装了 Codex”当成已兼容。双向维护是实验性入口，当前没有通过验证的写 adapter，保持不可开启。

已有 Launcher 的用户需按其实际版本自行实现正式生命周期 Hook。协议复用 `external-lifecycle --require-binding`，至少处理 prepare、started、beforeStop、afterExit、abort 与 recoverBeforeStart，保留返回 handle，正常停止必须等待持久关闭回执。Launcher 需提供能力说明，不能仅写一个开机脚本冒充 Hook。实现者可借助 LLM，但标准无 Launcher 流程不需要 LLM。

## 六、验收与升级

普通模式分别验证 Core 独立引用、DAG 保存后重开、Bridge 多 Vault 连接和断开后历史保留、无 CLI 时基础跳转、Sticker 的最小依赖组合。受管模式增加：服务未启动时拒绝启动、运行中失联停写、恢复后不重复提交、正常退出、重启恢复、解除注册前阻止未收尾运行。

本轮自动验证使用合成会话、临时 Vault 与测试页面；没有修改实际 Home、Vault 或 Launcher。宿主版本、模块、Node、CLI 或安装位置变化后，重新生成回执并用 `managed-instance check --target <ID>` 复核。完成新环境的实际交互验收后再用于真实数据。回退保留旧程序及备份，不能以旧程序直接覆盖已产生的新数据结构。


### 会话图的可选同步与恢复

只安装 Core + ThoughtDAG 即可使用图。安装 Maintenance 不会改变 DAG 的数据读取接口。
要同步图，在上面的知识扩展包中启用 `thoughtdag`，并在接入插件的 `extensionPlugins` 中加入
`namespace: thoughtdag, pluginVersion: 0.4.14-rc2.17, writerId: dsh-thoughtdag`，保留其它成员，然后重启受管实例。

已同步的图在打开所属会话时由 adapter 恢复到宿主会话扩展数据层，再交给 DAG 读取。
旧 schema 2 主干会自动转换逻辑会话身份；首次新保存使用 schema 3，旧对象原件保留，之后优先读取新格式对象。
不删除旧库、不手工复制图文件，也不需要 LLM 修改配置。多个旧主干、无法映射的来源、同修订不同内容会明确报错并保留原件，不创建空图覆盖。
未绑定的历史草稿不会被任意分配给某个会话，仍保留在维护历史中。

未配置该 adapter 时，图按本地能力使用；停用同步不删除本地或真源的数据。重新启用时如两侧各有修改，需要先核对差异，系统不会擅自覆盖。
实例已经注册 Maintenance 时，发送和图的持久修改仍受统一在线许可约束。同步失败保留本地编辑；重新读取会先核对已确认的远端修订。
