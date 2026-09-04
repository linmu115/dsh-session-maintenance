# Version negotiation

`adapterApiVersion` is a strict interface major. Core currently accepts major 1
and returns `ADAPTER_API_UNSUPPORTED` for another major before loading Adapter
code.

`declaredDshRange` and `testedDshVersions` are selection evidence. They are not
hard installation locks in experimental mode. Selection order is pinned,
verified, probe-compatible, then experimental. A new DSH prerelease outside the
declared range may run only after a successful probe and is recorded as
experimental. A failed capability probe always wins over semver text.

Package peer dependencies should use a broad or optional range. Runtime
capability checks decide compatibility; developers update the Adapter when a
real break is observed.
