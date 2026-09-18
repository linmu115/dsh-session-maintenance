# Engine .44: verify the complete declared release combination

Launcher discovery had two independent plugin allowlists ending at .29. Both now admit the released .30; Engine attestation also explicitly admits .44. Repository-wide runtime TypeScript/MJS search for current Engine/plugin release-family literals found three sites, all addressed: runtime-attestation and both launcher-discovery branches. Unknown versions remain rejected.

Existing dynamic tests already read both package manifests and reproduced three failures on .43/.30. Extend the explicit .30 regression and assert both projection and plugin capability statuses are supported for the actual Engine/plugin release combination, with and without GPT extension. Packaging now requires the full Launcher integration suite as well as attestation validation, including --skip-build.

Validation: 32 tests pass, including discovery, connect and runtime-binding recheck; Engine TypeScript passes. A negative experiment changing only the declared plugin to unlisted .999 causes the actual packaging gate to fail before creating its output directory; the manifest is restored. No production instance or prior archive was changed. Reuse the exact 9cfa2135e7e1de55d307f7d945191a9bae5131a79b2456cda59b14ca6c9e832c plugin archive; the inherited ui-build.json absolute sourceRoot remains a disclosed portability metadata exception.
