# DSH Session Adapter SDK

The Adapter SDK lets another developer teach Session Maintenance how one DSH
release stores sessions without coupling the canonical source to that release.

Start here:

1. Read [architecture.md](./architecture.md) for the trust boundary.
2. Read [contract.md](./contract.md) and [capabilities.md](./capabilities.md).
3. Copy the [minimal example](./examples/minimal-adapter/src/index.ts).
4. Run the Core Smoke described in [testing-guide.md](./testing-guide.md).
5. Record evidence in [compatibility-matrix.md](./compatibility-matrix.md).

The public interface major is `adapterApiVersion: 1`. DSH product versions are
probed by behavior and capability; they are not exact peer-dependency locks.
