---
name: dsh-session-continuation
description: Preview, create, inspect, or reopen a traceable native Codex continuation from a versioned DSH session through the local DSH Session Maintenance engine. Use when the user wants to continue a DSH conversation in Codex or inspect an existing continuation job.
---

# DSH Session Continuation

Use the maintenance MCP tools. Do not read or write Codex or DSH storage files directly.

For a new continuation:

1. Obtain the logical session ID, exact source version ID, registered Codex target preset ID, and handoff mode.
2. Call `continuation_preview` first.
3. Report the estimated tokens, budget, omissions, and immutable archive IDs.
4. If `allowed` is false, do not call create. Ask the user to select checkpoint or structured-summary mode.
5. Call `continuation_create` only after the user has explicitly asked to create the continuation.
6. Return the native Codex task ID and continuation job ID. Repeated identical requests are idempotent.

Use `continuation_status` to inspect a known job. Use `logical_session_open` to obtain its stable local detail URL. A `manual-review` result means the Codex task ID was preserved but verification must be recovered from the maintenance CLI; never create a replacement task automatically.

When two platform branches have diverged, use `resolution_preview` and then `resolution_create` only after the user supplies an explicit merge note. Keep left and right histories as separate parents; never reorder their messages into a fabricated timeline. The resulting Codex task must bind to the generated two-parent resolution version, while both original refs remain unchanged.

DSH tool records in a handoff are provenance records, not Codex tool executions. Never describe them as having run in Codex.
