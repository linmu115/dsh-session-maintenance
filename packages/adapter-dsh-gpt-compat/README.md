# GPT compatibility session adapter

This package implements the Maintenance Harness Adapter contract for DSH 0.1.5-rc.2 with dsh-gpt-compat 0.5.0-dev.N (N >= 1). Adapter ID: `dsh-gpt-compat`. Native format: `dsh-gpt-compat-v1-jsonl-zstd`. It requires the attested `dsh-gpt-compat/session-v1` capability and pinned plugin artifacts.

Its own codec validates the five context/checkpoint, checkpoint-commit, operation, operation-result and request/projection events, including earlier-event references. Opaque state is preserved as JSON; required events are never silently removed or made ignorable. V3 mechanisms are shared through an asynchronous call scope; the ordinary V3 decoder remains unchanged.

Engine discovery, runtime attach/recovery, evidence checks and Core receipt selection route through this independent identity. Legacy receipts remain ordinary V3. Changing format identity changes the native-space key, so deployment must stop the target, back up state and regenerate verified receipts before repair/restart. Do not reuse a bundle that globally redirects DSH imports.

See [contract](../../docs/adapters/contract.md) and [change report](../../docs/reports/2026-09-17-gpt-format-adapter.md). Tests use synthetic data and temporary directories.
