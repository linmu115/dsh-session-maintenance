# Dashboard and host acceptance — 2026-09-18

Full bounded acceptance passed after the public business page integration:

- Dashboard: **22 files, 73 tests passed**.
- Maintenance host plugin: **26 files, 122 tests passed**.
- Total: **48 files, 195 tests passed**, no remaining failures.

The first run exposed an existing package test still asserting `0.2.26-rc2.14`; the root agent authorized updating it to the current `0.2.26-rc2.29` candidate. All exact DSH RC2 peer compatibility assertions remain intact.

The existing host gateway unload test used a hand-written object that lacked Cordis service reflection. It now uses a real Cordis Context and plugin fiber, exercising the new service registration and verifying both endpoints are unregistered on disposal.

An additional real Cordis test verifies that an optional consumer can arrive before the Maintenance service, attaches once when the service arrives, tolerates an unavailable Engine, and stops all retries on unload. A standalone service with no Bridge consumer performs no Engine requests. This test performs no real data writes and uses a deliberately throwing synthetic connection provider.

No application implementation changed during this acceptance pass. Tests/report are isolated from the root agent's runtime and release edits.
