# Adapter compatibility and deployment evidence

This matrix separates implemented codecs, fixture validation, and recorded deployment. A successful probe is not an end-to-end support promise for arbitrary Harness builds.

| Exact DSH family | Implemented Adapter | Evidence and limit |
| --- | --- | --- |
| `0.1.2-alpha.2` | `dsh-alpha2`, Adapter API 1 | Public npm contracts and synthetic Core Smoke; the 2026-09-01 Alpha2 → RC2 candidate report still reserved manual UI acceptance |
| `0.1.2-rc.1` | `dsh-rc1`, Adapter API 1 | Official types/implementation and synthetic contracts; recorded 2026-09-05 live combination: Engine 0.1.14 + Maintenance 0.2.16 + SCM 0.3.1 at `4b49927`; this does not imply every UI action was revalidated |
| `0.1.1-rc.2` | `dsh-rc2`, Adapter API 1 | Synthetic legacy persistence, append, reference and cross-version fixtures; historical Gateway acceptance is separate from Canonical deployment |

Sources: [Alpha2 contract](../../packages/adapter-dsh-alpha2/COMPATIBILITY.md), [RC1 contract](../../packages/adapter-dsh-rc1/COMPATIBILITY.md), [RC2 contract](../../packages/adapter-dsh-rc2/COMPATIBILITY.md), [candidate validation](../validation/canonical-projection-final.md), [current baseline audit](../validation/2026-09-05-maintenance-architecture-review.md), [RC1 identity and empty-session repair](../changes/RC1-SCM-IDENTITY-AND-EMPTY-SESSION.md).

RC1 requires the exact `0.1.2-rc.1` DSH/session/persistence package set and `sessionPersistence`; other version sets fail. Alpha2 and RC2 may classify other capability-compatible builds as compatible or experimental, but those builds are not added to the verified matrix without exact evidence. The minimal SDK example is synthetic, not a supported product adapter.

The current [external lifecycle Provider](../../apps/engine/src/external-lifecycle-provider.ts) accepts Alpha2 `0.1.2-alpha.2` and RC1 `0.1.2-rc.1`. RC2 codec availability does not mean RC2 is accepted by this Provider. The [Generation script](../../scripts/package-canonical-projection.mjs) still lists Alpha2/RC2 standalone packages and profile templates; it is not proof of an RC1 release combination.

Unknown native events preserve evidence through normalization. RC1 specifically holds unknown semantics outside model-visible user/assistant/tool-result messages. Missing persistence seams or failed probes must not be bypassed by editing a version string.
