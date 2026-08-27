# Session Maintenance Phase 2C DSH Plugin and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. P22 contains a formal-profile approval gate; stop before that gate unless the user explicitly authorizes it.

**Goal:** 打包全新的 `dsh-session-maintenance` 插件，为官方 DSH 提供会话右键入口和轻量参数/操作面板，并完成阶段二 clean-clone 与正式 profile 验收。

**Parent plan:** `2026-08-27-session-maintenance-phase-2-dsh-write-and-ui.md`

## Global Constraints

- 仅在 Batch B Gate 通过后执行。
- 插件 host 只组合 P15 的 gateway、受限 Engine client/proxy 和设置；client 只提供入口。
- 不修改 Codex UI，不保留 `/codex-sync`，不兼容旧 ledger，不依赖 EAC 或特定桌面壳。
- DSH 客户端结构 Adapter 必须锁定官方 `0.1.1-rc.2` fingerprint，漂移时 fail closed。
- P21 不安装正式 profile；P22 先在隔离 profile 验证。
- 卸载旧同步插件、删除旧目录或修改正式 profile 需要在预览后获得用户明确确认。

---

### Task P21: Build the version-locked DSH entry plugin

**Files:**
- Modify: `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`
- Create: `plugins/dsh-session-maintenance/{package.json,tsconfig.json,cordis.patch.yml,README.md,LICENSE}`
- Create: `plugins/dsh-session-maintenance/src/{index,config,engine-proxy}.ts`
- Create: `plugins/dsh-session-maintenance/src/client/{index,context,ui-contract,session-locator,context-menu,settings-actions,dashboard-entry,styles}.tsx`
- Test: `plugins/dsh-session-maintenance/test/{host,proxy,ui-contract,context-menu,settings-actions}.test.tsx`
- Add: `fixtures/dsh/0.1.1-rc.2/client-contract/**`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-021.md`

**Interfaces:**
- Produces: npm package `dsh-session-maintenance`; host gateway/proxy; `SessionMaintenanceActions` client service.
- Peer contracts: exact compatible `@deepseek-ai/*@0.1.1-rc.2`, Cordis `4.0.1`; optional Dashboard tab Adapter may integrate with `dsh-better-sidebar` but core actions must work without it.

- [x] **Step 1: Capture the supported DSH client/settings contract**

Record synthetic DOM/service fixtures for session rows, stable session IDs, current-session resolution, settings registration and action feedback. Compute one client fingerprint. The Adapter may use DSH services where available; any DOM fallback is isolated in `session-locator.ts` and may not leak selectors into menu/business components.

Add red tests proving the supported fixture enables actions and one changed selector/service fingerprint produces `UI_CONTRACT_INCOMPATIBLE`, no menu injection and no uncaught plugin-load error.

- [x] **Step 2: Implement the host composition and restricted Engine proxy**

Host composes P15 `dsh-host-gateway` and a fixed-operation proxy to Engine. The proxy reads the Engine connection capability only on the host side, allows only current-session scan/plan/apply/status and Dashboard link resolution, strips path-shaped fields and applies request/response limits.

If Engine is offline, buttons return a short actionable error. The plugin does not start, stop or patch Engine, DSH, EAC or a desktop shell.

- [x] **Step 3: Implement session context-menu actions**

Phase-two enabled actions:

```text
在维护看板中打开
扫描此会话
同步到 DSH / 生成安全计划
与 Codex 版本比较
查看版本图
建立 Checkpoint
解除映射
归档
删除（仅查看删除候选；阶段二不执行平台删除）
```

“创建 Codex 延续任务”和“启用原生双向镜像”显示为后续阶段能力或不渲染，不能提交作业。菜单使用稳定 session ID；标题只能辅助展示，不能作为身份。

点击同步先生成/读取计划：safe plan 才允许应用；review plan 打开 Dashboard；阶段二不支持的平台删除只打开候选说明。菜单本身不执行平台写入。

- [x] **Step 4: Implement the lightweight parameter/action panel**

Parameters: registered Codex instance、official DSH instance/profile、workspace mapping、single-sided title sync、scan scope、backup retention、allow batch safe apply。实际 root/path registration remains CLI/installer-only.

Buttons: `扫描当前会话`, `同步当前会话`, `打开会话维护看板`. Stage-three “创建 Codex 延续任务”可以显示为 disabled 并带简短说明。

Panel only shows the most recent action’s short feedback and plan/job ID. It must not render compatibility cards, transaction lists, pending counters or long-lived status dashboards.

- [x] **Step 5: Implement Dashboard entry without a hard sidebar dependency**

Primary action opens the standalone Dashboard deep link for the selected logical session. If a compatible `dsh-better-sidebar` exists, register one optional tab that embeds the same Dashboard URL; otherwise use ordinary browser navigation. Business behavior and gateway do not depend on sidebar availability.

- [x] **Step 6: Verify, document, and commit P21**

Test supported/unsupported client fingerprints, missing current session, Engine offline, review plan, duplicate click, proxy path rejection, optional sidebar absent and plugin unload cleanup. Build the tgz and inspect contents/peer versions. README explains prerequisites, install, use and update behavior in user language; technical recovery details link to docs rather than dominating README.

Write `...021.md`, update progress, and commit `feat: add DSH session maintenance entry plugin`.

---

### Task P22: Package, clean-clone test, stage, and formally replace the old sync plugin

**Files:**
- Modify: root `package.json`, `pnpm-lock.yaml`, `README.md`
- Create: `scripts/{bootstrap-phase2,package-phase2,assert-phase2-portable}.mjs`
- Create: `tests/contract/phase-2-boundaries.test.ts`
- Create: `tests/integration/phase-2-acceptance.test.ts`
- Create: `tests/e2e/phase-2-dashboard.spec.ts`
- Create: `docs/deployment/{INSTALL,UPGRADE,UNINSTALL,RECOVERY}.md`
- Create: `docs/validation/phase-2-acceptance.md`
- Create: `docs/changes/DSH-SESSION-MAINTENANCE-20260827-022.md`

**Interfaces:**
- Produces: repeatable Engine/Dashboard/plugin artifacts, installer inputs, clean-clone CI entry, formal acceptance record.

- [ ] **Step 1: Write the failing clean-clone and boundary tests**

From a clean temporary clone, run pinned bootstrap, build, unit/integration/UI tests and packaging twice. Assert second bootstrap leaves lockfile unchanged and artifacts are reproducible except explicitly documented timestamps.

Scan production dependency graph and built artifacts for `dsh-codex-session-sync`, `/codex-sync`, old broker, EAC, Maintenance runtime, local `file:D:/...`, credentials and account-specific absolute paths; expected: no match. UI vendor files must match recorded source/SHA/license decision.

- [ ] **Step 2: Implement package and portable installer inputs**

Produce separate versioned artifacts for Engine+Dashboard and DSH plugin, plus a manifest containing version, Git commit, supported DSH contract, SHA-256 and dependency list. Installation registers Engine state root/instances through trusted CLI and installs the plugin into a caller-selected official profile; it never assumes `web-desktop` or EAC.

Document prerequisites, install, first scan, daily use, update, rollback and uninstall. Do not delete old plugin data automatically.

- [ ] **Step 3: Run an isolated profile acceptance**

Create a marked temporary DSH `0.1.1-rc.2` profile, install the packaged plugin, start the minimal official DSH stack, and verify:

- plugin loads without failed-loader diagnostics;
- right-click and settings actions reach the fixture Engine;
- Dashboard deep link opens the selected logical session;
- Codex → DSH safe fast-forward succeeds;
- divergent sessions remain separate;
- injected verification failure restores;
- uninstall removes plugin registration but preserves Engine repository and platform sessions.

- [ ] **Step 4: Run final automated phase-two gates**

Add scripts `test:phase2`, `test:phase2-ui`, `package:phase2`, `verify:phase2-clean`. Run Node `22.19.0` and `24.x` clean bootstrap where available, phase-one regressions, all phase-two tests, portability scan and `git diff --check`.

- [ ] **Step 5: Stop for formal-profile approval**

Generate a preview containing exact official profile ID, current/new plugin package versions, package/lock/bundle changes, Engine instance mapping, backup/rollback locations and the old `dsh-codex-session-sync` entries proposed for removal.

Do not alter the formal profile until the user explicitly confirms this preview.

- [ ] **Step 6: After approval, perform the formal profile transaction**

Back up the formal profile package manifest, lockfile, plugin artifact reference and loader configuration. Install the new package, rebuild/restart official DSH using its normal supported lifecycle, then verify loader health, session visibility, menu actions, scan, safe plan and Dashboard.

Only after the new baseline passes, uninstall `dsh-codex-session-sync` from package dependencies and DSH bundles. Preserve its recoverable package reference until the acceptance record is signed; delete old ledger only under a separate explicit cleanup request.

Failure restores the exact pre-change profile files/package graph and verifies official DSH starts again. It does not leave both sync plugins enabled.

- [ ] **Step 7: Record acceptance and commit P22**

Write `phase-2-acceptance.md` with commands, versions, hashes, test counts, formal transaction ID and any disabled capabilities. Write `...022.md`, update progress, and commit `feat: package and validate phase two`.

## Batch C / Phase 2 Gate

- New plugin remains a thin entry/Adapter package; Engine owns all plans, transactions and recovery.
- Official DSH client drift disables only DSH menu/panel, not Dashboard, Engine or read-only history.
- The packaged system installs without EAC, old sync, Maintenance runtime or local source checkout.
- Formal profile replacement is transactional and user-confirmed; old sync is not silently removed.
- Phase-one read-only and phase-two write/UI suites both pass before the branch is ready to finish.
