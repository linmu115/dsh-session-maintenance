# V3 lifecycle changes

Source evidence is restored by its owning registered adapter through an owner-scoped read port, then exported with source format, version and digest to the V3 target. Foreign reads are rejected and canonical source arrays remain immutable. Full loads, selected session loads and version recovery all use the same restoration path.

NativeSpace rereads each staged artifact and invokes the adapter codec verifier before journal publication. JsonProjectionDirectory retries short Windows EPERM/EACCES/EBUSY replacement failures without removing the published target; the 205-session fixture reproduced the old failure and passed with bounded atomic retries.

Targeted source-owner fixtures and all five native-space cases pass. V3 migration/provider/Core validation and deployment boundaries are documented in the adapter and Engine package change reports. No live data is changed by this implementation work.
