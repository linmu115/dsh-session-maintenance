# Canonical Generation — DSH core dependency externalization

## Failure

Installing the canonical Alpha2 plugin set caused Profile `web` to contain
`@deepseek-ai/schemastery@3.18.1` and its transitive
`@deepseek-ai/cosmokit@1.8.2`. The Alpha2 CLI/runtime owns newer copies, so the
Profile dependency self-check correctly rejected the mixed core package tree.

## Root cause

The source manifests of Annotation Core and Sticker Board used Schemastery as
a normal runtime dependency. Canonical packaging copied that declaration into
their portable artifacts. pnpm therefore materialized the old package in the
Profile; Sidechat and Agent Teams then resolved their optional Schemastery peer
against that copy. Session Maintenance 0.2.0 itself did not include either
package in its runtime manifest.

## Change

Annotation Core `0.3.6` and Sticker Board `0.4.22` now externalize Schemastery
in their source manifests. Canonical packaging additionally externalizes
host-owned Schemastery and CosmoKit
declarations. If a replacement plugin declares either package, its candidate
artifact receives an open, optional peer instead of a runtime or optional
dependency. The DSH CLI/runtime remains the sole owner of those core packages,
and experimental version combinations are not rejected by a hard peer range.

This rewrite is limited to Generation artifacts. It does not change source
development dependencies, application code, Dashboard, canonical storage,
adapters, or any user session data.

## Focused verification

- Unit contract: direct and optional host dependencies become optional `*`
  peers while unrelated dependencies and peer metadata remain unchanged.
- Candidate artifact audit: Annotation Core and Sticker Board package manifests
  no longer contain Schemastery or CosmoKit as materialized dependencies.
- Reproducible-package verification now rejects every tarball that could install
  either host-owned package through `dependencies` or `optionalDependencies`.
- `canonical-2cab6a3fd4e9aab2` reproduced all 32 outputs and contains the corrected
  Annotation Core `0.3.6` and Sticker Board `0.4.22` artifacts.
- Profile repair remains a separate, explicit lifecycle action: stop Alpha2,
  reinstall the rebuilt artifacts through the official plugin command, verify
  the lock/tree, then restart. No live Profile mutation is performed by this
  source change.
