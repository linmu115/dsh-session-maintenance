# Maintenance Dashboard and Instance Integration Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans task-by-task. User approved this scope and GPT-6 Astra delegation; no additional design approval is needed for these tasks.

**Goal:** Deliver a readable static conversation dashboard and usable per-instance onboarding, with workspace sync configuration kept separate from connection setup.

**Architecture:** Keep platform formats in adapters, installation/discovery in a Harness integration module, and orchestration in Engine. Persist explicit instance/profile bindings in Maintenance state; the existing generic Launcher lifecycle provider checks those bindings. Official Codex native write feasibility is a separate evidence task, and unsupported native write remains disabled.

**Tech Stack:** TypeScript, Node >=22.19.0, React 19, Vite 7, Zod, existing Maintenance contracts/client/store; pnpm 11.19.0.

**Spec:** Approved discussion and `C:/Users/19717/OneDrive/文档/ChatGPT/dsh/.artifacts/dashboard-sync-design-20260906/接入向导与Codex原生同步验证.md`.

## Global Constraints

- Baseline Maintenance 9d2279b, Launcher 47b2d5d; preserve earlier fixes and deployed state.
- First supported integration family: Launcher-managed DSH and local Codex; show actual capability, not a blanket compatibility badge.
- Static reading offers no model input, send, body rewriting or Harness-dependent load path.
- Main navigation: 会话、同步、恢复点、存储空间、设置. Remove overview and standalone plans; contextual advanced details retain diagnostics and recovery functionality.
- Workspace allowlist includes future sessions automatically; absent native writer must never be presented as working sync.
- Do not write real Codex or DSH homes during implementation and verification. Use marked synthetic fixtures.
- Store shared DTOs in packages/contracts. No EAC or dsh-codex-session-sync runtime compatibility.
- Every task has focused behavioral verification, a change report, and a separate commit; controller serializes commits.

## Task 1: Dashboard reading and navigation

**Files:** apps/dashboard/src/{app,session-workbench,canonical-event-view,catalog-pages,operations-pages,storage-governance,dashboard.css}; new session-reader.tsx, integration-page.tsx, sync-page.tsx; tests in apps/dashboard/test; docs/changes/dashboard-reading-20260906.md.

**Consumes:** Existing canonical directory/session APIs, checkpoint/retention APIs. New integration contracts below are supplied by Task 2. API methods are optional on UI test doubles but implemented by the production client.

**Produces:** Five-entry DashboardApp, pure static reader with workspaces on the left, session Markdown on the right, readable recovery/storage flows, integration/sync settings screens.

- [x] Add behavioral tests for default sessions view, no overview/plan navigation, directory remains visible after opening a session, and reader offers no mutation/send controls.
- [x] Use listCanonicalWorkspaces and getCanonicalSession for reader; do not make reading depend on overview, runtime or mutation methods. Preserve cancellation and show empty/error states.
- [x] Render user/assistant text through existing SafeMarkdown; collapse tools/reasoning/details; keep raw IDs/JSON in optional technical details only. Keep workspace search and clear selection.
- [x] Rename Checkpoints to 恢复点 and explain the protected session/version and restore effect. Move historical transactions and diagnostics into advanced contextual disclosure. Preserve existing backend guardrails.
- [x] Present storage with used/protected/reclaimable distinctions and preview-before-execution, existing retention behavior unchanged.
- [x] Add integration and sync screens against Task 2 API; show unsupported native sync reason and future-session rule explicitly.
- [x] Run `pnpm exec vitest run apps/dashboard/test packages/session-ui/test --maxWorkers=1`, dashboard typecheck/build, then document and commit.

## Task 2: Integration discovery, saved binding, lifecycle consumption

**Files:** new packages/contracts/src/integrations.ts; packages/contracts/src/index.ts; packages/local-api-client/src/client.ts; new apps/engine/src/integrations/{service,launcher-discovery,bindings}.ts; apps/engine/src/{engine,composition-root,external-lifecycle-provider}.ts; new http/integration-routes.ts and routes.ts registration; new focused Engine/contract/client tests; docs/changes/instance-integrations-20260906.md.

**Public contract (all fields required unless marked optional):**

```ts
type IntegrationCapability = { id: string; label: string; status: 'supported' | 'unavailable' | 'unchecked'; detail: string };
type IntegrationTarget = { id: string; kind: 'dsh' | 'codex'; name: string; version: string; profile: string | null; status: 'available' | 'connected' | 'needs-attention' | 'unsupported'; adapterId: string | null; capabilities: IntegrationCapability[]; issues: string[] };
type IntegrationDirectory = { targets: IntegrationTarget[]; launcherDetected: boolean; nativeSyncSupported: false; nativeSyncReason: string };
type IntegrationAction = 'connect' | 'check' | 'repair' | 'disconnect';
interface IntegrationApi {
  listIntegrations(signal?: AbortSignal): Promise<IntegrationDirectory>;
  integrationAction(targetId: string, action: IntegrationAction, signal?: AbortSignal): Promise<IntegrationDirectory>;
}
```

- [x] Test synthetic Launcher catalog/profile discovery and real installed package version inspection. Ignore unsupported profiles/versions with actionable reasons, not successful compatibility.
- [x] Implement stable target IDs scoped to host/instance/profile; source paths are resolved internally from discovery, never accepted as arbitrary browser mutation paths.
- [x] Save bindings atomically in Maintenance state with environment fingerprint; match exact instance/profile during lifecycle prepare. Disabled/unbound targets do not start the Engine or prepare projections. Existing deployments need explicit, narrowly scoped adoption rather than global opt-in.
- [x] Connect/repair uses discovered target and the existing official DSH installation/lifecycle mechanism, rechecks prerequisites, then publishes binding only on success. Preserve unrelated Hook configuration, and refuse to overwrite another provider. Disconnect removes the selected binding without deleting conversations.
- [x] Preserve prepare/beforeStop/afterExit/abort semantics, lease identity and final acknowledgement. On upgrade fingerprint mismatch, require a successful check/repair before reusing connection.
- [x] Expose authenticated integration routes under `/v1/integrations` through existing bearer/UI CSRF checks; validate DTOs in shared contracts and client.
- [x] Run new tests plus external-lifecycle-provider, runtime-broker, HTTP authorization and client suites. Document actual supported installation scope and commit.

## Task 3: Workspace sync configuration with truthful native-write gate

**Files:** packages/contracts/src/integrations.ts; new apps/engine/src/integrations/sync-policy.ts; integration routes/client; apps/dashboard/src/sync-page.tsx; plugin settings copy; focused tests; docs/changes/workspace-sync-policy-20260906.md.

**Interface:**

```ts
type WorkspaceSyncPolicy = { revision: number; workspaceIds: string[]; includeFutureSessions: true; nativeWriteEnabled: false };
type SyncWorkspace = { id: string; name: string; roots: string[]; sessionCount: number; eligible: boolean; reason: string };
type WorkspaceSyncConfiguration = { policy: WorkspaceSyncPolicy; workspaces: SyncWorkspace[]; nativeSyncSupported: false; nativeSyncReason: string };
interface WorkspaceSyncApi {
  getWorkspaceSync(signal?: AbortSignal): Promise<WorkspaceSyncConfiguration>;
  saveWorkspaceSync(input: { revision: number; workspaceIds: string[] }, signal?: AbortSignal): Promise<WorkspaceSyncConfiguration>;
}
```

- [x] Test persistence/restart, optimistic revision conflict, unknown workspace rejection, automatic future-session inclusion, and native writes always disabled while unsupported.
- [x] Persist scope independently of connection bindings. Selection is configuration only until native synchronization passes its separate acceptance gate.
- [x] UI presents workspace scope and future-session inclusion, saved versus active status, and missing capability explanation. Remove ineffective legacy plugin toggles from ordinary settings, link to dashboard synchronization settings.
- [x] Do not build a speculative writer or authorize native data writes using mutable display grouping. Eventual enqueue/commit-time native ownership validation remains an explicit native-writer prerequisite.
- [x] Run focused API/client/plugin checks; document and commit.

## Task 4: Native Codex feasibility and integrated acceptance

**Files:** throwaway probes/evidence in existing dashboard-sync-design-20260906 directory; summarized report in docs/validation/2026-09-06-codex-native-sync-feasibility.md; final docs/validation/2026-09-06-dashboard-integrations.md.

- [x] Inspect current official local schema/control implementation; test remaining candidate history import/resume methods only in isolated synthetic homes and loopback model fixtures.
- [x] Record original ID, visible native history, model request context and reload behavior separately. Do not claim desktop UI/reference acceptance from protocol-only results.
- [x] If official post-hoc native turn import is unavailable, retain an explicit unavailable native-write gate and report compatible alternatives and their scope changes.
- [x] Review specification coverage, then code quality across completed tasks; fix findings and rerun affected checks.
- [x] Run whole-workspace typecheck/build and existing test suite once after focused checks; investigate real regressions. Preview the Dashboard against a synthetic Engine and visually verify reader/navigation/settings through browser tools if available.
- [x] Commit evidence/change reports and leave a concrete candidate for user acceptance. Deployment of the new candidate is a distinct final operation after verification; real Codex native writes are not part of this implementation stage.
