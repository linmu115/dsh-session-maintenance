# Version-open entry plugin peers

## Change

`dsh-session-maintenance@0.1.2` no longer gates installation on exact DSH or Cordis package versions. Every peer dependency now uses `*`, optionality is unchanged, and the fixed `dshWorkshop.compatibility.dshVersions` declaration is removed.

The entry plugin therefore loads in experimental DSH combinations and discovers actual capabilities at runtime. Development dependencies remain pinned for reproducible testing. Data-writing adapters still require their schema and recovery probes to pass; this protects session data and is independent of package-version admission.

The workspace disables pnpm peer auto-installation. Tested DSH packages are listed explicitly as devDependencies, so reproducible development does not turn into a runtime version gate.

## Validation

- Focused package policy test.
- Phase 2 plugin and integration suite: 34 files and 62 tests passed.
- Plugin typecheck, build, and package dry-run.

## Rollback

Revert this commit and redeploy the previous `0.1.1` artifact.
