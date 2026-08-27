# DSH Session Maintenance Codex Plugin

This plugin is a thin Codex entry point for the local Session Maintenance Engine. It does not read or write DSH or Codex platform storage.

1. Start the Engine with `dsh-session-maint serve`.
2. Set `DSH_SESSION_MAINTENANCE_STATE_ROOT` to the Engine state directory before starting Codex.
3. Install this directory as a Codex plugin.
4. Ask Codex to preview a DSH session continuation. Creation is only allowed after an explicit preview and user request.

The Engine must already contain a registered Codex instance and target preset. Configure those with `instance add` and `codex-target add`.
