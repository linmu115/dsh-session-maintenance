# DSH 0.1.5-rc.2 Core host

Use `createDsh015CoreHostBinding(input)` from this package; do not adapt the new context to `LockedRc2CoreExtension` or old borrow/coordinator methods.

```ts
const binding = await createDsh015CoreHostBinding({
  runtime: ctx, importAnchor: import.meta.url,
  instanceId, profileId, runId, branchId,
  receiptPath, receiptSha256,
});
const gateway = createDsh015HostGateway([{
  instanceId, host: binding.host,
  expectedContractFingerprint: binding.expectedContractFingerprint,
}], { tokens, materializationProbe: binding.materializationProbe });
// Plugin disposal: await binding.dispose().
```

`collectDsh015CoreBindingReceipt({importAnchor,materialization})` reads the actual importer closure and returns a reviewable object, without writing it. After acceptance, save it and pin the raw file SHA-256. `materialization` has `sourceHash` and `artifactHash`, both `sha256:<hex>` over LF-normalized dsh-015-host.ts / built dsh-015-host.js. The plugin bundle must contain the separately copied dsh-015-host.js beside its entry. Collector output includes `node: {path,sha256}`; runtime binding checks the actual Node binary too. Receipt trust must come from the accepted release, not an unreviewed self-generated observation.

The input call signature is stable. It requires actual session, JSONL persistence, workspace registry, projection-cache and query/storage-domain services. The imported classes must own the live service objects. Pins cover entry and manifest files for all seven imported RC2 packages. Mixed importers or changed files fail.

Cold read uses a read handle and official validateStoredEvents. Offline admission reserves the ID before awaiting, blocks Session prepare/enter and external write open/create, tracks existing writers, and holds the official JSONL write lock for the entire transaction. Read handles remain concurrent. Create/append flush and finally close through a borrowed owner handle. No runtime second writer is opened.

Workspace and projection snapshots use the public registry and storage-domain table; sessionQuery.readSession supplies query reconciliation. Fixed RC2 lacks a public unarchive API: only unarchive uses pinned enqueueOperation/state/setState. Native rollback has no public replacement API either: while holding the official writer lease and excluding Agent entry, the managed native-space owner atomically replaces the sole V3 zstd artifact and independently reopens it. Retained/future generations, wrong root/run, symlinks or changed immutable headers refuse rollback. These narrow seams must be re-audited on every upstream version change.

Tests include actual released RC2 JSONL create/append/flush/close, snapshot restoration and new-writer cold read in synthetic temp native-spaces; other services use synthetic fixtures. Full deployed gateway acceptance is separate. The old 0.1.1-rc.2 Core files are retained untouched.
