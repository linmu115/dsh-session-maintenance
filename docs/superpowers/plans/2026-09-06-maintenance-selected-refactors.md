# Selected Maintenance refactors — 2026-09-06

This amendment implements the user's eight annotations against the necessity
review. It narrows the original 2026-09-05 construction plan; it does not reopen
the already released Engine 0.1.15 / plugin 0.2.17 / SCM 0.3.2 batch.

Baseline: `0dbf921cf0e6aaaee22dfed7df0c1d334ce4205f`, including the RC1 recovery
default fix `37c1bfe`. Integration remains in its existing isolated worktree.
Production runs, source homes, rollback packages and unfinished worktrees are
preserved. Automated verification uses marked synthetic directories.

| Item | Owner / reasoning | Scope and completion evidence |
| --- | --- | --- |
| SM-05 (annotation 1) | commands / GPT-6 Astra high | Engine import jobs, online/offline exclusion, cancellation/retry/idempotency, writer coordination covering object creation through reference commit; focused concurrency tests |
| SM-06 (annotation 2) | root | Extract only responsibilities touched by this batch; keep one runtime identity and state coordinator; lifecycle regression tests, no wholesale split or projection format change |
| SM-07 (annotation 3) | root | Maintenance consumes deployed SCM API 1; remove competing menu listener; lifecycle, cancellation and exact identity tests; preserve settings/dashboard entry |
| SM-08 (annotation 4) | metadata / GPT-6 Astra xhigh | Complete reference inventory and read-only preview, registered external sources, protection reasons, deduplicated bytes and conservative blockers; reference/race/path tests |
| SM-09 (annotations 5–6) | metadata / GPT-6 Astra xhigh | Finished runs, rebuildable caches and registered backups governed by retention/capacity rules; revalidated explicit execution, reversible quarantine, grace period, interruption and restore tests |
| SM-11 (annotation 7) | root | Verify the old index prefix and write only appended events; atomic full rebuild fallback; measured synthetic baseline and semantic regression tests |
| SM-13 (annotation 8) | adapters / GPT-6 Astra high | Preserve prior Launcher patches, commit reproducible generic Hook implementation with bounded I/O, timeouts, startup/exit handling and independently runnable tests |

SM-10 (five-day history pruning) and SM-12 (chunked body storage) are outside
this amendment. Every existing version body remains protected by SM-08/09.
SM-11 can be implemented without SM-10: its former dependency controlled edit
ordering, not a technical requirement. SM-09 depends only on the runtime
interfaces it actually needs, not a comprehensive SM-06 split.

The root coordinates shared exports, composition, API wiring, migrations and
version identities. Commands initially reserved migration 018 but now expects
to reuse existing jobs tables. Storage migrations start at 019 if needed;
unused numbers do not imply an unapplied migration.

Each item receives focused validation, a change report and a source commit.
After integration, run type checking, builds, affected lifecycle/identity
regressions, then the complete test suite once against the final combination.
Source completion, packaged verification and production activation are recorded
separately. Building governance does not itself run reclamation on user data.
