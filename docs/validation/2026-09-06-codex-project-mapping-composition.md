# Codex project mapping composition integration

The dedicated `codex-project-mapping-composition.test.ts` exercises the actual Engine composition, HTTP mapping routes, canonical import and RC1 projection preparation with marked synthetic source homes.

The HTTP test rejects unauthenticated GET/PATCH, rejects a cookie request without CSRF and a request from a different Origin, accepts the authenticated directory request and valid UI cookie/CSRF PATCH, and rejects a stale compare-and-swap revision. Saving revision 1 leaves the active policy and existing canonical sessions unchanged until preparation.

The fixture initially imports a selected member and an outside member through the legacy unconfigured path. It then adds another selected member plus a deliberately missing outside rollout. Both native projects have identical names and roots. Real `engine.prepareProjectionRuntimeRun` imports only the two explicitly selected native members, creates adapter evidence, tombstones the previously imported outside member and activates the saved scope. A call-through broker assertion verifies that activation and pruning are already complete and the outer database transaction has committed when materialization starts. The real RC1 preparation produces exactly those two sessions in its projection repository and physical projection directory. Source file hashes remain unchanged.

SQL tracing confirms that the same prepare call executes all three nested transaction paths: `canonical_commit` for a newly imported session, `codex_observation` for the existing unchanged session, and `project_roots_replace` for canonical project roots. The test uses actual SAVEPOINT operations, not mocked stores. A focused call-chain review found no remaining unconditional nested BEGIN in the actual import path: adapter evidence, workspace upserts/membership, event-index updates and version metadata snapshots use the enclosing transaction; metadata advancement already uses a SAVEPOINT. Independent canonical repository derivation methods and status-event transactions are outside this startup import call chain. Broker status logging starts after activation commits.

A second test serializes a scoped import plan with canonical JSON and then applies the reconstructed plan. This reproduces and protects the correction to scope validation: compare the revision and normalized project-ID set rather than JSON object key order. Canonical serialization can legitimately reorder the scope fields.

Validation passed:

- `pnpm exec vitest run apps/engine/test/codex-project-mapping-composition.test.ts --maxWorkers=1 --testTimeout=20000` — 2 tests.
- `pnpm --filter @linmu/dsh-session-maintenance-engine typecheck`.

The observer timer is stopped within the HTTP integration test so its independently tested periodic work does not race the explicit preparation assertions. The real server and preparation lifecycle remain in use.
