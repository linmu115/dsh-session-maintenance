# Maintenance 0.1.15 live release

The user authorized committing and activating the completed batch, then personally
accepting its UI. Activation was verified on 2026-09-06 at 00:26 China time.
No browser/computer-use acceptance or model call was performed.

## Installed combination

| Component | Version / identity |
| --- | --- |
| Engine + bundled Dashboard | Engine 0.1.15, source `37c1bfee18c3141261f5725ee64735c84731756f`, clean source |
| Maintenance DSH plugin | 0.2.17 |
| Session Context Menu | 0.3.2, source `0a98ea9` |
| Metadata schema | 17 |
| DSH / profile | Official 0.1.2-rc.1 / web |
| Launcher | Existing 0.2.2 executable, byte-identical to backup |
| Contracts / Dashboard package | 0.1.0 / 0.1.0 |
| Embedded alpha2 / RC1 / RC2 adapter identities | 0.1.0 / 0.1.2 / 0.1.0 |
| Adapter / projection / external lifecycle protocols | 1 / 1 / 1 |

Included: SM-00 through SM-04 and SCM action host. Paused import coordination,
Launcher refactoring, Maintenance action registration, five-day retention and
automatic reclamation are not deployed. Other plugin dependency specs and the
profile's bundle order were preserved.

Protected installation/rollback root:
`D:/AI/DSH-Plugin-Releases/maintenance/engine-0.1.15-plugin-0.2.17-scm-0.3.2`.
Active entry: `installation-final/dsh-session-maintenance/engine/dsh-session-maint.mjs`.
Launcher uses its existing trace wrapper and 300000 ms hook timeout. Engine PID
at verification: 29996. DSH PID: 65520, parent Launcher PID: 6892.

## Artifacts and validation

| Artifact under the release root | SHA-256 |
| --- | --- |
| `packages-final/dsh-session-maintenance-engine-0.1.15.tgz` | `971f95ab7c144205fa7aff96901e92099ab61b7abf003faaf05b13058fe0f36a` |
| `packages-final/dsh-session-maintenance-0.2.17.tgz` | `bc1ef52b5e6a202229af3cfbc5d19f62395e32de870a99e2842ea430893391d6` |
| `packages/dsh-session-context-menu-0.3.2.tgz` | `ec6d08a0ae83d2089c346fe254e6d14fffb67d2dddb0743053fd77eaf529cc87` |

Two final builds produced identical Engine, plugin and manifest bytes. Portable
verification checked 27 artifact files. The final archive passed standalone
Dashboard discovery/authentication/graceful shutdown and all three upgrade
verifier tests without a skipped positive case.

Workspace typecheck/build passed. The initial 158-file / 458-test suite had 456
passes, a large catalog timeout and a scan racing another test's rebuild. Both
affected files passed serially (3 tests), without relaxing assertions/timeouts.
After the recovery fix, final typecheck/build and all 20 files / 98 RC1, broker
and lifecycle tests passed, including five new positive/negative regressions.
SCM build, syntax checks and all 34 tests passed.

## Data preservation and deployment findings

The first and final archives each migrated a read-only SQLite copy of the real
schema 16 database inside an isolated fixture. Row hashes matched before/after
for 520 logical sessions, 5634 versions, 5131 parent edges, 245189 canonical
events, 16 derivations and 50 checkpoints. Integrity, foreign keys, schema 17
and repeated-open stability passed. Unverified historical metadata stays unknown.

The final active database is
`C:/Users/19717/AppData/Local/DSH-Session-Maintenance/metadata.release-20260905-0-1-15.sqlite`.
The consistent schema 16 baseline remains in the rollback snapshot. During setup,
the official plugin installer appended two internal Obsidian components to the
top-level bundle list; the previous order was restored before DSH started.
An initial Engine start migrated the prior database before this profile guard
finished. Its schema 17 state was preserved as evidence, schema 16 was restored
from the consistent snapshot, and final activation selected a separate database.

The previous run `run-36dfa0e8-fbde-43a4-9581-202098ecb1e0` had seven committed
operations with receipts and no pending WAL, but a header recovery failure held
the writer lease. Launcher correctly refused the first attempt with `LEASE_HELD`.
The official RC1 writer persisted optional `delegationDepth` as zero while the
logical header omitted it. The narrow `37c1bfe` fix normalizes only this official
default; all other header, lineage and committed-prefix checks stay enabled.
See [the recovery fix report](../changes/SM-14-rc1-depth-recovery.md).

The fixed reader checked all 340 mappings read-only: zero uncommitted native
tails. Retrying the existing Provider afterExit/Broker protocol produced a real
`recovered` final receipt at 2026-09-05T16:21:19.037Z and checkpoint
`checkpoint_6fb14a89d86953242cc8c6a8`. No direct lease/state edit or forged receipt
was used. Normal recovery cleaned its temporary run; the original native files,
projection and WAL remain in the protected backup.

## Live evidence and handoff

Launcher reported RC1 web ready at 00:22:54 China time. New run
`run-b52c5a29-5a91-4d3a-988b-cf545acf0cda` was running with zero pending operations.
DSH authentication returned 303, its HTML returned 200, and its installed
Maintenance proxy returned 200 with Engine online. Engine health, Dashboard HTML
and built script returned 200. Packaged authentication also checked unauthorized
API rejection, cookie bootstrap, CSRF overview and one-use launch expiration.

Observed origins: DSH `http://127.0.0.1:14455`, Engine `http://127.0.0.1:25294`.
Use Launcher to enter DSH and the plugin button for a fresh authenticated
Dashboard entry. UI clicks, actual continuation, same-title menus and normal
stop/restart acceptance remain with the user.

`release.json` and `evidence/live-final.json` in the release root contain compact
deployment records. Rollback includes the schema 16 database, approximately
2.8 GiB of objects, 7.1 GiB of projection/recovery files, lifecycle handles,
old Engine/plugin archives, profile files and Launcher/configuration copies.
Copy logs show zero failed/mismatched files. Profile junctions were not followed;
old package archives and lockfile support official reinstallation. No retention
or historical GC ran.

Rollback requires consistent database/object/recovery files and matching old
binaries/profile. Preserve any data written after handoff first; never point
Engine 0.1.14 at a schema 17 database.
