# RC2 copy: append after a converted native history

An RC1 history retained 4,850 canonical events, while its RC2 native projection
contained 255 events. The next native tail used offsets 255–258. Treating those
offsets as canonical sequence numbers caused version validation to reject the
append. Both ordinary sends and cross-session capture flushes therefore reported
`Projection append did not reach a durable Maintenance receipt`.

Canonical append now shifts an overlapping incoming batch after the frozen base
history. The batch keeps its relative order, event IDs, raw payload, source
offsets and native receipt revision. Duplicate IDs, invalid offsets, out-of-order
events, stale base versions and tombstones remain rejected. Receipt replay remains
idempotent. No existing history is renumbered or rewritten by the fix.

The actual failed operation was inspected using a read-only database and a
disabled commit method. It reproduced `Canonical event sequence is not strictly
increasing`; the same validation will be repeated against the corrected build.

Validation: 21 canonical engine tests and 64 adapter/projection lifecycle tests
passed, including synthetic 4,850-to-255 history conversion, the next append,
receipt replay, invalid input rejection and existing crash-recovery coverage.
Engine 0.1.33-rc2.4 is paired with plugin 0.2.26-rc2.3. Live deployment and recovery
receipts are recorded under artifacts/reference-delivery-fix-20260913.

Live recovery committed the failed batch and the remaining native tail, adding
nine canonical events while preserving all 4,850 previous events byte-for-byte
at the canonical object level. The failed operation now has a durable receipt.
Deployment also exposed a release-version allowlist that omitted rc2.4. The
attestation schema now admits this tested release; the regression test reads the
current package version so future release bumps cannot silently omit it. Exact
artifact hashes, instance identity and capability checks remain required.
Launcher discovery also recognizes paired plugin 0.2.26-rc2.3 as already
installed, avoiding an unnecessary install during reconnect. Its test likewise
checks the current packaged plugin version while preserving the requirement for
a separately verified RC2 host attestation.
