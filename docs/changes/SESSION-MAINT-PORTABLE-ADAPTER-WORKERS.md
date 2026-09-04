# Portable Engine Adapter workers

## Failure boundary

The Engine source locates Alpha2 and RC2 probe workers through workspace package
resolution. The standalone package previously emitted only
`dsh-session-maint.mjs`; after installation there was no `@linmu` workspace
tree. Importing the Engine therefore failed with `MODULE_NOT_FOUND` before its
health endpoint or database recovery could start.

## Repair

- Package both isolated Adapter RPC workers beside the Engine under
  `engine/adapters/`.
- Resolve those bundled siblings in an installed Engine and retain workspace
  package resolution only as the development fallback.
- Keep resolution lazy so metadata-only CLI commands do not require worker
  discovery before a composition is opened.
- Record each worker's build inputs in the package manifest.

No Adapter logic is moved into Launcher. Launcher still invokes one generic
external lifecycle program; the Engine remains the sole owner of Adapter
selection and process isolation.

## Focused package breakpoint

The portable package check now requires both worker files and executes each one
through a bounded JSON-RPC probe before accepting the Engine artifact.
