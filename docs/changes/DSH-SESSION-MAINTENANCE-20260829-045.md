# Session Maintenance 0.1.3 - native Session Controller declaration

The plugin no longer declares or injects the removed `@deepseek-ai/dsh-client-runtime` package. Its browser half now declares the actual service it consumes, `@deepseek-ai/dsh-api-session-controller`, exclusively through `dsh.client.inject`, so pnpm does not turn a host-provided alpha service into an install constraint.

The client capability fingerprint is version-neutral and continues to test the concrete `sessions.list` and session-row surfaces. This preserves the experimental combination workflow: interface probes report drift without imposing a DSH version admission gate.

The package-local test command now anchors Vitest at the workspace root, so Maintenance and CI exercise the plugin tests instead of reporting a false “No test files found”.

Verification: focused plugin tests, workspace build, package dry run, and live alpha profile loading.
