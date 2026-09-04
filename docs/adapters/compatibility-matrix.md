# Adapter compatibility matrix

| Adapter | Adapter API | DSH version | Status | Evidence |
|---|---:|---|---|---|
| minimal example | 1 | synthetic future prerelease | experimental | SDK Core Smoke |
| DSH Alpha2 Codec | 1 | 0.1.2-alpha.2 | verified | Public npm contracts plus synthetic Core Smoke; no user log fixture |
| DSH Alpha2 Codec | 1 | other capability-compatible build | compatible / experimental | Runtime probe; semver is advisory rather than a hard lock |
| DSH RC2 Codec | 1 | 0.1.1-rc.2 | verified | Synthetic version-0 header, event, append, reference and runtime-hook fixture |
| DSH RC2 Codec | 1 | other legacy-hook build | compatible / experimental | `legacySessionPersistence` capability probe; semver is advisory |

`verified` requires fixture-backed probe, materialization, append, reference,
drain, and digest evidence for the exact DSH version. `compatible` means runtime
capabilities match an already-understood shape. `experimental` is allowed for
testing and must remain visible in verification records. `failed` is not
selectable automatically.

Unknown plugin events are held out for interpretation but retain their complete
native envelope through canonical normalization and rematerialization.
