# Public business information page contributions — 2026-09-18

## Outcome

Maintenance now accepts declarative plugin information pages independently of its existing extension data directory. Providers contribute summary, status, key/value, data-directory and declared action sections. React renders content as plain text and labeled native controls; providers cannot supply executable JavaScript or HTML. Existing extension endpoints and panels remain supported.

Ownership is instance + profile + namespace + provider + boot. Live owners cannot be replaced; heartbeats renew a 20-second lease, independent of action execution. Unload keeps the latest page offline, retires queued operations, and marks running operations uncertain. Engine restart retains snapshots and receipts but never automatically replays unfinished actions. Another boot cannot consume old actions.

The browser can enqueue only an action declared in the current snapshot, with matching expected revision and bounded declared scalar fields. It cannot register providers, poll executions or acknowledge them: these endpoints assert host bearer authentication after common Engine auth/origin/CSRF checks. Host-only credentials never reach a provider or the browser. Binding remains solely the contribution provider's Companion CAS action; Engine stores no alternative binding authority.

The host exposes optional `maintenanceBusinessPages`, with a frozen identity and `register(provider)` returning dispose. Providers must compare host identity with their own trusted runtime identity before registering. Engine outages are retried without blocking optional runtime startup. Host caches execution receipts by operation ID, so lost acknowledgements do not execute the handler again. Dashboard retains the original complete request after a lost enqueue response and retries its existing operation ID. It refreshes leases periodically and explains that an offline provider's pending result needs verification.

## Public API

`dsh-session-maintenance/business-pages` exports the provider/service and shared DTO types. The runtime entry is empty and cannot implicitly start Maintenance or import credentials/Engine. The build generates a self-contained declaration from the shared contract types, avoiding another handwritten DTO source. Consumer plugins may use type-only imports while retaining optional Cordis injection.

Engine integration uses `BusinessPageRegistry.create({stateRoot,writes})` and `routeBusinessPageRequest(...,{businessPages,hostAuthenticated})`. The root integration wires lifecycle/auth; the host registration receives a trusted Engine connection provider and fixed instance/profile identity.

## Persistence and boundaries

State is an atomic `business-pages.json` under the supplied Engine state root, serialized through the shared Maintenance write coordinator. Page snapshots are bounded to 32,768 JSON characters, 24 sections and 500 stored pages; action inputs have at most 16 bounded scalar fields. The ledger retains up to 2,000 receipts and then fails closed instead of evicting idempotency evidence. The atomic JSON reader has no smaller file-size cutoff, so valid maximum-sized persisted state remains readable. Automatic receipt archival is intentionally not implemented.

No real Codex/DSH home was written. Tests used marked synthetic temporary directories. No deployment was performed. UI validation was component-level; no real browser viewport or user Companion binding was exercised.

## Validation

- 20 passing focused/regression tests across Engine registry/routes, host polling and lost acknowledgement, public declaration consumption, Dashboard lost enqueue response and safe rendering, existing extension directory/page, and local API client.
- Typechecks passed for contracts, Engine, local API client, Dashboard and Maintenance host plugin.
- Full Maintenance host plugin build passed, including generated public declarations and inert public runtime entry.

Relevant test files: `apps/engine/test/business-pages.test.ts`, `plugins/dsh-session-maintenance/test/business-pages.test.ts`, `plugins/dsh-session-maintenance/test/business-pages-api.test.ts`, `apps/dashboard/test/business-pages.test.tsx`, `apps/dashboard/test/extension-page.test.tsx`, `apps/dashboard/test/extension-ownership-directory.test.tsx`, `packages/local-api-client/test/client.test.ts`.
