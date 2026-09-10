# RC1 runtime detail read refusal

Engine 0.1.27 restored historical `dsh-runtime/detail` evidence without an
`ignorable` envelope marker. RC1's compiled event vocabulary excludes plugin
events and refuses such records on persistence reads. Annotation history then
fails because the underlying session cannot be observed.

Engine 0.1.28 / RC1 adapter 0.1.4 marks only log-only `dsh-runtime/detail`
projection envelopes ignorable. IDs, sequence, time and payload are preserved;
canonical history and original evidence are untouched. The rule applies both
to restored historical evidence and directly normalized detail records. Core
controls and arbitrary unknown required events are not made ignorable. The
adapter version change invalidates previous projection caches on next startup.

Validation removes the marker from native metadata fixtures, covering original
ingestion, historical restoration, full/incremental/pinned reads, and repeated
projection. `scripts/verify-rc1-runtime-detail.mjs` additionally exercises the
installed official RC1 persistence coordinator: the old record fails, the new
projection loads with its detail payload intact, and an unrelated unknown
required event remains refused. Set DSH_OFFICIAL_ROOT to the RC1 version folder.

This fix is at the Maintenance projection boundary. RC1 Session.append does
not expose ignorable metadata; adding a third argument does not persist it.
Runtime Support's live display writer is unchanged. A cold persistence read
of newly appended detail in the same active run (before re-projection) remains
a separate limitation of that writer and needs a supported display transport.
Do not patch official Session methods or relax the generic unknown-event guard.
