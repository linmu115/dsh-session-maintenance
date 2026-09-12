# RC2 plugin entry and combined release

The plugin now targets DSH 0.1.5-rc.2, uses the V3 persistence handle boundary, includes format generation in cache identity, scopes reference resolution by the configured instance/profile, and binds Core mutation to the backend's attested native-space owner. Old private coordinator calls are no longer used by the deployed entry.

The public storage-domain API owns the projection cache domain. RC2's workspace header-index primitive remains a narrow version-specific seam; the optional client row decoration retains the verified RC2 workspace row and title selectors. Existing dashboard, SCM actions, extension object connection, canonical deletion and other-event cards remain enabled.

Validation: TypeScript and all 65 plugin tests passed, including real released JSONL empty-session writes, failed flush withholding hydration, concurrent cold open, logical resolver scope, trusted launcher receipt metadata, teardown and UI actions. Actual multi-package importer, Launcher, user-history conversion and restarts have separate deployment evidence; these unit tests do not establish those outcomes.

Builds externalize all @deepseek-ai packages so the profile supplies one real implementation closure. Combined packaging accepts an inspected --plugin-archive, verifies its runtime files against a fresh build and embeds those exact bytes. No installer sees a different package under the same plugin version. Runtime/Core version evidence is not substituted by package.json semver alone.

Configuration: native-mode Launcher supplies DSH_SESSION_MAINTENANCE_CORE_RECEIPT and DSH_SESSION_MAINTENANCE_CORE_RECEIPT_SHA256. The earlier CORE_BINDING_RECEIPT / CORE_BINDING_SHA256 spelling remains accepted for already prepared installer candidates. Browser input cannot choose a Core receipt or target resolver scope.
