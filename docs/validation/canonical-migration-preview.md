# Canonical migration preview and activation

- Preview time: 2026-09-01 (Asia/Shanghai)
- Source schema: v6
- Source database: `C:\Users\19717\AppData\Local\DSH-Session-Maintenance\metadata.sqlite`
- Candidate: `metadata.canonical-candidate.sqlite` (does not exist; preview created nothing)
- Rollback strategy: preserve source, activate only by candidate-copy-and-pointer-swap

## Counts

| Classification | Count |
|---|---:|
| Source logical sessions | 637 |
| Codex mirrors | 409 |
| Maintenance-native DSH sessions | 228 |
| Proposed derived sessions | 0 |
| Review required | 0 |
| Unclassified | 0 |

The source has 637 platform bindings: 409 Codex and 228 DSH. It has no `native_mirrors` rows because these sessions were imported as single-platform records. The original preview treated every no-mirror record as unclassified. T19 corrects that classifier to use the authoritative single-platform binding when no mirror row exists; a dual-platform binding without a mirror remains review-required.

## Source integrity

| File | Bytes | SHA-256 |
|---|---:|---|
| `metadata.sqlite` | 56,111,104 | `e0b42970efb7aa29312cb471e05c9fa2f3cc40fab2b3261203da3c7de1ff0bc4` |
| `metadata.sqlite-wal` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `metadata.sqlite-shm` | 32,768 | `fd4c9fda9cd3f9ae7c962b0ddf37232294d55580e1aa165aa06129b8549389eb` |

The preview used SQLite read-only mode. Hashes and sizes were unchanged after classification. No candidate, checkpoint, backup, pointer, or profile was created or modified before confirmation.

## Confirmation and activation

The user explicitly confirmed the preview before activation.

The first candidate exposed a migration breakpoint: all legacy heads were stored in
`platform_refs`, while `logical_sessions.canonical_version_id` was null. That candidate
contained zero canonical events, was never allowed to remain active, and the config pointer
was immediately restored to `metadata.sqlite`. It is retained as
`metadata.canonical-failed-no-heads.sqlite` for diagnosis only.

The corrected migration resolves the active head through the authoritative platform ref,
loads and validates every compressed normalized body, converts DSH raw envelopes once (without
duplicating the full normalized event), and reports the following status-log breakpoints:

- `migration.preview.verified`
- `migration.heads.loaded`
- `migration.candidate.copied`
- `migration.canonical.committed`
- `migration.integrity.verified`
- `migration.candidate.hashed`
- `migration.pointer.switched`

Final activated candidate:

| Item | Value |
|---|---:|
| Schema | 8 |
| Logical sessions | 637 |
| Canonical events | 423,100 |
| Logical workspaces | 131 |
| Workspace memberships | 637 |
| Candidate bytes | 611,160,064 |
| Candidate digest | `5fb555ff60cfa5d9fbe89af34fb8c632f4772d0509d7227b4bbbb6d5afc587c9` |

Post-switch checks: zero null heads, all 637 sessions have events, 409 sessions are
`codex/codex-mirror`, 228 are `maintenance/maintenance-native`, foreign-key check is empty,
and `PRAGMA integrity_check` returns `ok`. `config.yaml` now points to
`metadata.canonical-candidate.sqlite`.

Rollback remains a one-field pointer switch to `metadata.sqlite`. The source SHA-256 remains
`e0b42970efb7aa29312cb471e05c9fa2f3cc40fab2b3261203da3c7de1ff0bc4`; a second read-only
archive is `metadata.pre-canonical-v6-retry.sqlite`.
