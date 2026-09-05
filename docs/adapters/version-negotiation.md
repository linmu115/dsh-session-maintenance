# Version negotiation

`adapterApiVersion` is a strict interface major. Core currently accepts major 1
and rejects another major before loading Adapter code.

Selection and probe results are evidence, not permission to claim universal
Harness support. The SDK supports pinned, verified, compatible and experimental
selection, but the Adapter's own validation and the host Provider's runtime
allowlist still apply.

- RC1 requires the exact `0.1.2-rc.1` package set and persistence seam. It has no
  capability-only fallback for other releases.
- Alpha2 and RC2 expose broader probe ranges. A newly probed build remains
  unverified or experimental until its exact combination has recorded tests.
- A failed persistence/capability probe is not overridden by semver text or a
  profile setting.

See [compatibility-matrix.md](compatibility-matrix.md) for the actual evidence
and separate Provider limits. Keep native format knowledge inside the Adapter;
a breaking format requires deliberate implementation and review.
