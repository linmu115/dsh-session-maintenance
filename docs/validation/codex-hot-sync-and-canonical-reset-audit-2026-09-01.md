# Codex hot synchronization and canonical reset audit — 2026-09-01

## Scope and safety

This was a read-only audit of:

- `C:\Users\19717\.codex\state_5.sqlite` and registered rollout metadata;
- `C:\Users\19717\AppData\Local\DSH-Session-Maintenance\metadata.canonical-candidate.sqlite`;
- active DSH/Obsidian link markers under the configured Obsidian vault.

No Codex database, rollout, Maintenance database, object, workspace membership or Obsidian note was changed. No session was deleted.

## `CODEX_BUSY` finding

The diagnostic is emitted by the optional native Codex write adapter. It means Codex rollout replacement, SQLite publication and restore are disabled while `codex.exe` is running. It does **not** make read-only synchronization unsafe.

The live Codex database is in WAL mode. Maintenance can read it while Codex is running by:

1. opening `state_5.sqlite` read-only with `query_only` enabled;
2. reading each catalog batch inside one SQLite read transaction, which pins a consistent WAL snapshot;
3. reading a requested rollout with size and nanosecond-mtime checks before and after;
4. marking a moving rollout `retry` and importing it on the next incremental scan.

The adapter now exposes `catalog.snapshot` and `rollout.stability` diagnostic breakpoints. Native Codex writes remain fail-closed.

Live verification was performed while two `codex.exe` processes were present. The read probe remained `compatible`, listed all 480 threads, and returned a stable observation for the newest thread. The emitted breakpoints were `catalog.snapshot/succeeded/sqlite-read-transaction` and `rollout.stability/succeeded/double-stat`.

## Maintenance canonical truth now

| Item | Count |
| --- | ---: |
| Logical sessions | 637 |
| Codex mirrors | 409 |
| Maintenance-native DSH sessions | 228 |
| Session versions | 685 |
| Canonical events | 423,100 |
| Logical workspaces | 131 |
| Assigned workspace memberships | 635 |
| Unassigned memberships | 2 |
| Projection runs | 0 |
| Tombstones | 0 |

The current tree is workspace-derived, not project-derived. This is why a Launcher projection cannot reconstruct the intended Codex project directory and instead presents a large unclassified group.

## Codex truth now

| Item | Count |
| --- | ---: |
| Threads | 480 |
| Active threads | 338 |
| Archived threads | 142 |
| Saved projects | 33 |
| Saved project roots | 38 |
| Threads with `threads.project_id` populated | 0 |

Maintenance currently contains 409 of those 480 Codex thread IDs. There are 71 new Codex threads to import and no stale imported Codex ID absent from the current Codex catalog.

### Project is not workspace

The live schema proves the distinction:

- **Project:** a row in `projects`, with one or more paths in `project_roots`.
- **Workspace:** the individual thread `cwd`; different sessions in one project may have different working directories.
- `threads.project_id` currently exists but is null for all 480 threads, so it cannot be the primary mapper today.

Fallback mapping by the longest containing `project_roots.path` gives:

| Mapping result | Threads |
| --- | ---: |
| Unique project | 262 |
| Equal-length ambiguous project roots | 46 |
| Outside every saved project root | 172 |

Important unique examples include `dsh` (70), `Internship` (25), `mathematica-physics-section-ai` (25), `enterprise_agent` (22), `数字图像` (17), `计算机` (17), `国际象棋` (11), `skill管理` (10) and `最优化方法与理论_15578247-20260601-051725` (10).

The 46 ambiguous mappings are not safe to guess:

- 32 threads: `dsh` versus `无固定项目的工程pipeline或教程会话`;
- 12 threads: `dsh` versus `pdf_converse` versus `无固定项目的工程pipeline或教程会话`;
- 2 threads: `AI-for-Math` versus `dsh`.

The import must therefore preserve a separate project relation and workspace relation. Unique longest-root matches can be automatic. Equal-root ties require an explicit path override or a visible “待指定项目” bucket; projectless sessions require a named “Codex 项目外” bucket, never an unnamed project.

## DSH–Obsidian sessions to retain

The following five native DSH session IDs are referenced by active `dsh-reference`, `dsh-sticker` or sticker-backlink markers in the Obsidian vault and are the high-confidence retention set:

| Native DSH session | Current canonical logical session | Current title | Evidence |
| --- | --- | --- | --- |
| `session-e7e36c2b-9f7f-4140-8685-e0499d50508e` | not imported yet | Alpha2 bilateral acceptance session | Active sticker backlink and `dsh-reference` in `DSH Alpha2 双端验收.md` |
| `session-9ff2e47f-26ce-4178-9b44-94f9acd1a0c0` | `ls_d8bc245e0dc61d709e12d1a4` | 孪生素数猜想简介 | Active sticker note |
| `session-5e262b31-4c3e-42c9-9232-8ca029934466` | `ls_a231f5b1aa10e0affa8945fd` | iPhone投屏到Windows上，有线投屏 | Six active sticker records |
| `session-492a1b81-3b27-4daa-a378-41e3f7cc7b9b` | `ls_e678d7a2f1c6f60fe8228b5b` | 问题咨询 | Active sticker plus embedded `dsh-reference` annotation |
| `019ecc30-76ac-7e51-8a63-bc61157546d9` | `ls_88bec63d46c1a975c19d7ceb` | 电子书OCR-层级化 | Active sticker note |

All four currently imported retained sessions are already `authority_scope=maintenance` and `origin_kind=maintenance-native`. The Alpha2 acceptance session must be imported from DSH before reset. All five should then be assigned to the new `DeepSeek` project while retaining their actual workspace metadata separately.

Older sessions containing words such as “Obsidian” but with no live vault backlink were not promoted into the retention set. They require an explicit user addition if they must survive the reset.

## Exact reset and resynchronization plan

The requested operation should run only after the project schema/UI change is active:

1. Read-only preflight: re-resolve all five retained native IDs and record content digests.
2. Import the missing Alpha2 acceptance session so the retained set is complete.
3. Stop active projection leases; currently the audit found none.
4. Take an external rollback copy of the canonical database and object index. This is recovery material, not delayed deletion visible in Maintenance.
5. In one Maintenance-owned transaction, physically prune every logical session except the five retained IDs and their reachable versions/events/objects. Do not create tombstones or a retention-delay queue.
6. Create/resolve the `DeepSeek` project and assign the five retained sessions to it. Keep each session workspace as an independent field.
7. Hot-import all 480 current Codex threads. Identical future scans are no-ops; changing rollouts retry instead of importing a partial body.
8. Map each Codex mirror to a project using, in order: populated `threads.project_id`, explicit override, unique longest saved project root, `待指定项目` for ties, and `Codex 项目外` for unmatched sessions.
9. Rebuild the Launcher projection. Expected baseline is 485 logical sessions if all 480 Codex IDs and five retained DSH IDs remain distinct.
10. Breakpoint acceptance: project counts, `skill管理` placement, one multi-workspace project, one ambiguous mapping, one Obsidian roundtrip, and a second Codex scan producing no duplicate sessions.

The operation must not write to or delete from Codex. Codex remains independently authoritative; only its read-only mirror is recreated in Maintenance.
