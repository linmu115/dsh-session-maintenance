---
{
  "id": "SRC-source-inventory",
  "kind": "note",
  "title": "源码入口与依赖",
  "status": "current",
  "generated_by": "project-map-source",
  "summary": "绑定 Git 工作区的入口、静态依赖、待补登记与待复核说明；供人和 LLM 按需查阅。"
}
---
# 源码入口与依赖

这里是绑定工作区的静态扫描结果。用于补查入口、依赖和说明缺口；未登记不代表架构错误，静态引用不等于运行时调用。

LLM 阅读入口：`project_map.py source <地图> --kind entrypoint|dependency|call|symbol|gap|review --query <名称或路径>`。结果支持分页，不必加载全量源码。

## 工作区 source

分支 `codex/image-startup-recovery-20260917`，提交 `669c1ea33950855270eb0185b2d22fab98dd4670`；扫描 1015 个文件。内容指纹 `f623bd41d8004fed`。

### 入口

- `apps/dashboard/package.json` #/scripts/build：npm_script → `vite build`
- `apps/dashboard/package.json` #/scripts/typecheck：npm_script → `tsc -p tsconfig.json --noEmit`
- `apps/engine/package.json` #/bin/dsh-session-maint：package_entry → `./dist/main.js`
- `apps/engine/package.json` #/exports/./development：package_entry → `apps/engine/src/index.ts`
- `apps/engine/package.json` #/exports/./types：package_entry → `./dist/index.d.ts`
- `apps/engine/package.json` #/exports/./default：package_entry → `./dist/index.js`
- `apps/engine/package.json` #/scripts/build：npm_script → `tsc -p tsconfig.json`
- `apps/engine/package.json` #/scripts/typecheck：npm_script → `tsc -p tsconfig.json --noEmit`
- `package.json` #/scripts/bootstrap：npm_script → `node scripts/bootstrap.mjs`
- `package.json` #/scripts/build：npm_script → `pnpm -r --if-present build`
- `package.json` #/scripts/typecheck：npm_script → `pnpm -r --if-present typecheck`
- `package.json` #/scripts/test：npm_script → `vitest run`
- `package.json` #/scripts/test:phase1：npm_script → `vitest run tests/integration/phase-1-acceptance.test.ts tests/integration/phase-1-large-catalog.test.ts`
- `package.json` #/scripts/test:phase3：npm_script → `vitest run packages/handoff-context/test/handoff.test.ts packages/adapter-codex-continuation/test/contract.test.ts apps/engine/test/continuation-entries.test.ts tests/integration/phase-3-continuation.test.ts`
- `package.json` #/scripts/accept:phase3-live：npm_script → `node scripts/accept-phase3-live.mjs`
- `package.json` #/scripts/test:phase2：npm_script → `vitest run --maxWorkers=1 --testTimeout=15000 packages/transaction-engine/test packages/dsh-core-extension/test packages/dsh-host-gateway/test packages/adapter-dsh-write/test tests/integration/dsh-safe-fast-forward.test.ts apps/engine/test/phase2-api.test.ts apps/engine/test/job-runner.test.ts apps/engine/test/ui-session.test.ts apps/engine/test/dashboard-static.test.ts apps/engine/test/writable-composition.test.ts apps/dashboard/test packages/session-ui/test plugins/dsh-session-maintenance/test tests/contract/phase-2-boundaries.test.ts tests/integration/phase-2-acceptance.test.ts tests/e2e/phase-2-dashboard.test.ts`

### 依赖与待补登记

提取 4819 项导入、62090 条静态调用/继承线索；待核对登记缺口 745 项。
- `apps/dashboard/src/app.tsx:1` → `apps/dashboard/src/learning-page.tsx`
- `apps/dashboard/src/app.tsx:2` → `apps/dashboard/src/extension-page.tsx`
- `apps/dashboard/src/app.tsx:6` → `apps/dashboard/src/session-workbench.tsx`
- `apps/dashboard/src/app.tsx:7` → `apps/dashboard/src/operations-pages.tsx`
- `apps/dashboard/src/app.tsx:8` → `apps/dashboard/src/catalog-pages.tsx`
- `apps/dashboard/src/app.tsx:9` → `apps/dashboard/src/recently-deleted.tsx`
- `apps/dashboard/src/app.tsx:10` → `apps/dashboard/src/run-center.tsx`
- `apps/dashboard/src/app.tsx:11` → `apps/dashboard/src/adapter-page.tsx`
- `apps/dashboard/src/app.tsx:12` → `apps/dashboard/src/storage-governance.tsx`
- `apps/dashboard/src/app.tsx:13` → `apps/dashboard/src/integration-page.tsx`
- `apps/dashboard/src/app.tsx:14` → `apps/dashboard/src/sync-page.tsx`
- `apps/dashboard/src/app.tsx:15` → `apps/dashboard/src/instance-workspace-page.tsx`

### 待复核说明

本次没有发现相对既有基线的变化；尚无人工核对基线的说明不因此视为有效。

### 覆盖范围

排除或不支持的文件 527 项，解析限制 111 项。仅扫描当前 Git 工作区，包含未忽略的新文件；不进入子仓库、依赖包或默认排除目录。动态调用、反射、路径别名及未支持语言需另行核对。完整清单通过 `--kind coverage` 查询。
