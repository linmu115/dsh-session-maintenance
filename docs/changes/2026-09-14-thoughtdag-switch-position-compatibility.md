# ThoughtDAG switch-position compatibility

The conversation/canvas switch-position fix is released as `dsh-thoughtdag` `0.4.14-rc2.4`. Maintenance's explicit extension compatibility list now accepts that version, so installing the UI fix keeps the existing ThoughtDAG extension panel and graph data available.

Engine is released as `0.1.33-rc2.12`, and the RC2 runtime attestation accepts that Engine version. The Maintenance integration plugin remains `0.2.26-rc2.9`. This change does not alter graph schemas, storage, session contents, or migration behavior.

Validation:

- Engine typecheck passed.
- Managed graph schema, extension data, and RC2 runtime attestation checks passed: 12 tests across 3 files, using synthetic fixtures.
- Package output is built from the committed tree. Deployment and runtime acceptance are recorded separately by the coordinating task.
