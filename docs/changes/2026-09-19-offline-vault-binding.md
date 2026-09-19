# Maintenance 内管理离线 DSH 实例的 Vault 绑定

用户在 2026-09-19 当前任务明确要求并授权修改：先列已登记实例，点击弹出卡片；每个Vault一行及解绑按钮，右上角新建绑定调用本机文件夹选择；DSH不必启动。

## 最终行为

扩展 → Obsidian Bridge → Vault绑定成为Maintenance自身入口，不依赖在线业务页provider。卡片按稳定instanceId/profileId查询绑定；新建由Engine打开Windows目录选择，检查.obsidian、桥manifest/main/data及精确兼容版本0.7.0-rc2.4，重新核验在线Vault身份、publisher、boot与真实路径。已绑定其他实例不自动改绑。

实例目录仅查持久接入登记与Launcher名称目录，不做运行探测、attestation或GPT索引。已知Vault从Maintenance显示索引及Obsidian登记目录的桥bindingState读取；不会遍历笔记。离线Vault显示上次已知状态；要变更绑定，仍须打开Obsidian并启用桥，DSH可以离线。在线发现和路径证明各有2秒总等待上限，避免离线候选串行放大等待。

Obsidian桥仍为唯一绑定写入者。Maintenance签发绑定专用30秒HMAC授权，关联Vault/publisher/boot、稳定实例/profile、操作ID、CAS修订和bind/unbind意图。桥读取同用户受保护的本机Engine连接密钥核验，拒绝浏览器Origin、伪造、过期和身份变化；不生成controller token或运行身份。两侧用原子文件/既有串行写入及持久操作回执；丢失解绑响应后同操作重试可核对结果。此通道不用于Viewer、引用或会话写入。

## 验证

Maintenance：23项相关测试通过（5绑定服务、1HTTP边界、1卡片、3扩展页面、4导航分类、1索引延迟、6真源名单、2同步栏目）。Engine、Dashboard、API client类型检查通过，Engine与Dashboard构建通过。Obsidian桥：21项相关测试通过（maintenance-binding、vault-binding、vault-location），类型检查与独立main.js构建通过，输出不含外部contracts依赖。

真实浏览器仅使用合成fixture，无任何在线DSH或业务provider：进入绑定管理、列实例、点击卡片、右上新建、逐行解绑和更新结果均检查。文件夹选择在浏览器验收中使用合成替身；Windows系统对话框视觉未验收。真实Vault写入和生产安装均未执行。

## 交付边界

Obsidian侧候选为0.7.0-rc2.4，需与这次Maintenance代码配套部署；旧桥会明确要求更新。当前已安装运行版尚未替换，本轮不强停任何实例或维护引擎，不修改真实绑定/同步名单/笔记。先前真源名单修改及扩展导航修复仍在本工作树，生产激活状态与其分开记录。

提供方接口：packages/contracts/src/vault-bindings.ts；Engine apps/engine/src/vault-bindings.ts；UI apps/dashboard/src/vault-binding-page.tsx；桥侧 src/binding/maintenance.ts 与既有 VaultBindingProvider。
