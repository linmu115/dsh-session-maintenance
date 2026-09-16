# Launcher restart identity repair

The RC2 copy failed before Engine startup with `INTEGRATION_RECHECK_REQUIRED`.
The Launcher binary SHA-256 was unchanged, but its receipt changed the executable
path from `D:\ai\dsh-launcher\dsh-launcher.exe` to
`D:\AI\DSH-Launcher\dsh-launcher.exe`. The capability digest hashed that spelling,
invalidating the runtime attestation and instance binding.

Engine 0.1.33-rc2.27 hashes the verified filesystem-resolved executable path.
Process ownership and executable content verification remain required. Existing
bindings with the old spelling need a one-time verified repair; future casing
and separator changes preserve identity.

Validation: all 30 integration tests passed, including a Windows regression that
changes casing and separators after binding, then resolves the runtime again.
The existing binary mismatch and stale process tests remain passing.

Deployment targets only the RC2 copy's binding and the shared Maintenance Engine.
The DSH plugin remains 0.2.26-rc2.22. No session, graph, or reference content is
deleted to repair startup. Runtime verification evidence is recorded locally in
`D:/AI/DeepSeekHarness-Plugin/artifacts/rc2-copy-startup-20260916`.

Further startup checks found a previous unfinalized runtime and seven obsolete
Codex desktop migration aliases. The old runtime was recovered using the official
lifecycle provider after verifying its process and listener were gone.

Engine 0.1.33-rc2.28 includes the path fix and ignores a deleted project's migration
alias only when the migrated server project is absent, no desktop project record
remains, and no current local thread references either identity. It keeps all
existing checks for missing active projects and ambiguous memberships. Codex
source files are read only; no aliases are deleted from the source.

Regression cases cover unused aliases, remaining desktop project records, and
remaining desktop/server thread memberships, plus the project mapping suite.
