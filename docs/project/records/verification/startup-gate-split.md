---
id: VER-startup-gate-split
kind: verification
title: 启动门分离的测试与边界证据
status: current
---

# 启动门分离的测试与边界证据

实现见 [[IMP-startup-gate-split]]。日期：2026-09-21。工作树 `codex/image-startup-recovery-20260917`（含未提交改动）。

## 已执行

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 接入用例全集 | `vitest run --maxWorkers=1 apps/engine/test/integrations.test.ts` | 34 项全部通过 |
| contracts 类型检查 | `tsc -p packages/contracts --noEmit` | exit 0 |
| 接入适配层类型检查 | `tsc -p packages/instance-integration-dsh --noEmit` | exit 0 |
| 引擎类型检查 | `tsc -p apps/engine --noEmit` | exit 0 |
| 回归基线对比 | `git stash push` 两个源码文件后重跑同一批用例 | 基线通过、改动后失败，确认两处失败由本次切分引入 |

其中两项为本次新增：

- 「does not gate a launch on ordinary plugin composition, but still records it」：安装、升级、移除普通业务插件（`dsh-obsidian-bridge`）后 `fingerprint` 不变、`pluginInventory` 变化；移除后库存回到基线值。
- 「keeps gating on the instance identity, effective patch layers and integration plugin contract」：环境覆盖变化、实际安装版本变化、用户 patch 层出现/消失、接入插件包身份替换分别移动门槛，且这些场景下 `pluginInventory` 不变。

## 未覆盖 / 不得据此宣称

- 没有任何真实实例验收：没有在本机实例注册、启动或复现「安装 Bridge 后仍可启动」的原始触发场景。
- 本机安装的发行版引擎不含此修复，用它验收会得到「未修好」的错误结论。
- 未验证 RC2 路径下 `attestationDigest` 对运行时闭包的覆盖是否足以替代原 `versions`/`manifests` 项（理由：回执按文件哈希钉住闭包，但仍属推断，未见针对该路径的专门用例）。
- 与本次改动无关的既有失败基线：`session-stickers.test.tsx` 9 项 React `act()` 失败、`graph-ui.test.mjs` 拖拽时序 flake。
