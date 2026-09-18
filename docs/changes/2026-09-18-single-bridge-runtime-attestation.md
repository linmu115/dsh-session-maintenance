# Admit the verified single-Bridge runtime cohort

Engine 0.1.33-rc2.38 and Maintenance plugin 0.2.26-rc2.29 were already declared and packaged, but the runtime attestation enum and both Launcher plugin admission lists still stopped at the previous release. Consequently valid current-release receipts were rejected and the plugin was reported unavailable before instance startup.

This patch adds exactly Engine .38 and plugin .29 to the existing three explicit lists. It does not infer compatibility from package.json, accept ranges or disable file/identity/Launcher/capability checks. Regression checks now explicitly retain Engine .37 and plugin .28 while admitting .38/.29; current manifest based tests still ensure a future release needs an explicit gate update.

Validation: before the fix, the two focused Engine suites reproduced five failures out of 32 tests. Afterward, all 32 pass, including isolated Launcher discovery, connect and pre-start integration resolution for the current release with and without GPT format extension. Future versions, extra version suffixes, identity/closure/capability mismatches and changed artifact bytes remain rejected. Engine TypeScript no-emit validation and build pass.

The candidate is regenerated after this commit into the new `.artifacts/single-bridge-attestation-20260918` directory, leaving the prior candidate untouched. This is a source/package fix only: no installed files, runtime attestation, Engine service, shared database, real session or Vault was modified.
