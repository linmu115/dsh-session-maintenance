# Session Maintenance implementation plan

Date: 2026-09-05. Documentation-only change, based on `a6b4053` and its parent
`4b49927`. The identity/deletion and RC1 blank-session fixes in `4b49927` are
already committed; a read-only remote lookup confirmed the matching remote
branch still points to that exact commit.

The plan converts the architecture audit into ordered implementation tasks with
file ownership, GPT-6 Astra subagent effort choices, explicit dependencies,
acceptance checks, release gates, and data-format rollback requirements.
It uses four responsibility groups, with no more than three child agents active
at once. This document does not dispatch those implementation tasks.

The audit is archived unchanged under `docs/validation` so the plan has a fixed
review source. The implementation plan is under `docs/superpowers/plans`.

Key decisions include protecting the existing working behavior, independent
historical metadata, shared command/read interfaces, one Adapter registration
path, coordinated import writes, a read-only retention planner before cleanup,
and a five-day revision window that protects current content and recovery
references. Chunked body storage remains conditional on measured costs after
the initial index optimization. Launcher work remains a separate repository
and commit stream.

Verification for this documentation change: audit archive content hash matches
the original; local Markdown links resolve; task identifiers are unique; the
dependency graph is acyclic; Git whitespace and baseline ancestry checks pass.
No new runtime tests are needed for this documentation-only change.

No source behavior, package version, installed plugin, runtime configuration,
database, object, cache, backup, or Launcher file was changed. The existing
Dashboard patch is still an unactivated source candidate. Future task completion
must distinguish committed code, validated packages, and live activation.
