# GPT progress release qualification

Register GPT 0.5.0-dev.7 as an exact supported extension version; unknown versions still fail qualification. No session format or recovery rules change. Engine 0.1.33-rc2.36 includes the same updated manifest in its main bundle and independent worker. Plugin remains 0.2.26-rc2.28.

Validation: all 10 extension adapter tests passed, including dev.7 qualification and unknown-version rejection. Engine typecheck passed. The current installed host persistence and GPT format validation passed, and the runtime binding was repaired through the supported API. The new instance reached running. See docs/project/records/history/context-progress.md for the deployment sequence and validation boundaries.
