# Testing guide

Use `runAdapterCoreSmoke` with a synthetic environment and projection. Core
Smoke intentionally covers only:

1. manifest negotiation and probe;
2. one canonical session materialized to a temporary writer;
3. inspection and digest verification;
4. one native append normalized to canonical DTOs;
5. one stable-reference resolution;
6. attach, drain with zero pending operations, and detach.

Run narrower tests around a failed breakpoint. Do not begin with a combinatorial
matrix. Keep real user homes, sessions, tokens, and Maintenance databases out of
fixtures.
