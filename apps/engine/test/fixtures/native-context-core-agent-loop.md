# Synthetic native context producer fixture

`native-context-core-agent-loop.json` was emitted by Annotation Core's scripted native `AgentLoop` integration test on 2026-09-15. The official `agent.inject(context)` and `followup(user)` path initialized the protected system head. The actual DSH tool runtime and `agent/pre-step` applied a partial Annotation context replacement across three `GenerateOptions` assemblies: inspect retained material, request release, then continue with the reduced input. The provider was a scripted in-process fixture; no network request or model call was made.

It contains a complete native execution, 3 original material descriptors, one release operation and its receipt. It is committed as an immutable cross-repository protocol fixture so Maintenance tests do not depend on another checkout or an absolute artifact path.

The test splits the durable prefix at the replacement sequence reported in the receipt; the remaining events finish the scripted native execution. Original user requests, comments and unselected context stay present. The session uses the native agent's initialization sequence and explicit native header metadata required by the v3 persistence format.
