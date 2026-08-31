# Adapter compatibility matrix

| Adapter | Adapter API | DSH version | Status | Evidence |
|---|---:|---|---|---|
| minimal example | 1 | synthetic future prerelease | experimental | SDK Core Smoke |

`verified` requires fixture-backed probe, materialization, append, reference,
drain, and digest evidence for the exact DSH version. `compatible` means runtime
capabilities match an already-understood shape. `experimental` is allowed for
testing and must remain visible in verification records. `failed` is not
selectable automatically.
