---
id: IMP-startup-gate-split
kind: implementation
title: 启动门与普通插件库存分离（MNT-001）
status: current
---

# 启动门与普通插件库存分离（MNT-001）

对应问题登记：`docs/issues/2026-09-20-managed-plugin-composition.md`（MNT-001）。用户边界：普通业务插件的增删升级不得单独阻止实例启动；只有具体核心合同不兼容才限制受影响操作，且错误须指出实际条件。

## 实现

`packages/instance-integration-dsh/src/launcher-discovery.ts`

- `contractFingerprint`（仍作为启动门）：实例身份（Launcher 根、instance/home/version id 与各根路径）、Launcher 能力摘要 `hostDigest`、RC2 运行时回执摘要 `attestationDigest`（回执本身已按哈希钉住运行时闭包）、实际安装版本 `actualVersion`、改变读取环境的环境覆盖、**生效的用户 patch 层摘要 `patchDigests`（profile 与 home 的 `cordis.patch.yml`）**、**接入插件自身的解析结果 `plugin`（含 bundle patch 摘要）**。
- `pluginInventoryFingerprint`（只记录、不拦截）：普通业务插件的 `versions`、`manifests`、`webApp`、`bundles`、`extraBundles`。
- 调用点改为同时写入 `fingerprint: contractFingerprint({...})` 与 `pluginInventory: pluginInventoryFingerprint({...})`。

`packages/contracts/src/host-integration.ts`

- `DiscoveredIntegration.fingerprint` 的文档改为「身份 + 实际接入合同」，明确普通业务插件组合被排除。
- 新增可选字段 `pluginInventory?: string`，注明仅用于解释与展示；真实不兼容仍由 `pluginReady`、声明的宿主/adapter/会话格式与逐包版本检查拦截。

## 中途修正（写入历程，不放宽结论）

第一次切分只把「身份 + 格式合同」放进门槛。结果两个既有验收用例失败：写用户 patch 层（`refuses disabled session services and fingerprints both effective user patch layers`）和替换接入插件包身份（`detects changed package identity before launch and repairs only after verification`）都不再移动门槛。用 `git stash` 回到基线重跑同一批用例确认「基线通过、改动后失败」，判定为本次引入的回归，才把「生效用户 patch 层」和「接入插件自身解析结果」放回合同，只把普通业务插件组合移出。

## 状态与边界

- 源码改动**未提交**，未构建进任何发行包；本机安装的发行版引擎（.58 / 接入 .36）不含此修复。
- 未做真实实例验收。`apps/engine/test/integrations.test.ts` 的通过只支持它检查的行为。
- 未实现：诊断性 `revalidate`（按用户边界，不拿新命令替代边界修正）；MNT-002 未知数据无损往返审计。
- 实例侧启动门本身（`plugins/dsh-session-maintenance/src/registered-startup.ts` 的拒绝加载）本轮未改动。用户已明确把它排在「引擎侧检出 + 接管 + 覆盖同步」之后再做，见 [[REQ-detached-instance-attach-sync]]、[[DEC-directory-connect-sync-authority]]。
