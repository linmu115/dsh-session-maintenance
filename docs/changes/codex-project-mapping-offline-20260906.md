# Offline Codex project selection inheritance

Canonical reseed previously constructed an unrestricted Codex importer against a new database. Conversation repair likewise froze and replayed unrestricted plans. Both could bypass a configured active project list.

The new offline helper reads the existing policy with the shared contract schema. A missing config, old schema without the policy table, or absent policy row retains legacy behavior. An unreadable active database or malformed policy fails; it never becomes unrestricted mode. Scope uses only active project keys and the Adapter's fresh explicit project directory, without cwd inference. Saved next-start intent is preserved independently.

Reseed resolves the active database through config, captures its policy, copies the policy into the candidate, and checks the source pointer and policy again during import and before final validation. A new empty candidate cannot erase an existing scope. Explicit empty scope imports zero Codex tasks.

Conversation repair includes policy in source digests, inherits scope during preview, keeps source and scope fields in frozen summaries, and checks fresh scope during application. It rejects old unrestricted plans after a policy is configured and rejects an older source database whose policy differs from the active database. Backup preserves policy; activation checks source, candidate, and active policy consistency. Legacy unconfigured source digest shape remains unchanged.

Validation uses synthetic marked fixtures only: selected and empty reseeds, saved/active distinction, frozen scoped replay, empty repair, membership movement, old full plans, old source databases, malformed policy, and activation after policy changes. All 8 new tests plus 5 existing reseed/topology tests passed (13 total); Engine typecheck and the edited tracked-file whitespace check passed. No real Codex files or Maintenance runtime data were modified.

Limits: these checks cover reseed and conversation-repair entry points, including their candidate activation function. They do not add a policy guard to every generic database-pointer or external deployment mechanism. Failed candidates remain inactive for diagnosis, matching the existing repair/reseed behavior.

Full-suite follow-up: updated the authorized historical migration tests to use `MAINTENANCE_SCHEMA_VERSION` for latest-version expectations. Fixtures that rewind a freshly created database now remove migration 21's policy/removal tables and its registration before replaying older migrations. The migration-20 rollback fixture removes all registrations at or above 20. Existing failure/rollback/retry assertions remain intact; production migrations were not relaxed. All 9 targeted files passed, covering 20 tests (migration 009–012, Adapter evidence, repository, version metadata, retention migration, and canonical migration activation).
