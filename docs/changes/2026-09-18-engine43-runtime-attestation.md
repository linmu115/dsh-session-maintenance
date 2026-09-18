# Engine .43 runtime attestation release fix

Engine .42 was released while the RC2 runtime attestation schema only allowed through .41. Its own generated receipt therefore failed with V3_ATTESTATION_REQUIRED. Add the actually released .42 and new .43 explicitly; do not admit arbitrary future versions or loosen identity, capability, package-closure or artifact digest checks.

The regression test now exercises .42 and .43 as well as the version read dynamically from apps/engine/package.json. The existing dynamic check already detected the .42 defect when run; the release gap was omission of that test from packaging. package-phase2 now runs this complete synthetic receipt check before creating/deleting output, including --skip-build.

Validation: reproduced the previous .42 failure; updated receipt test passes; TypeScript checks for Engine and Core host materialization pass; Dashboard builds. Temporarily setting the release manifest to unverified .999 makes the actual packaging command fail before creating any output directory, then the manifest is restored to .43. Plugin code/version is unchanged at .30 and packaging must preserve exact embedded/standalone plugin bytes. Portable archive checks follow the committed build.

No runtime instance, production configuration or existing frozen archive was modified. This addresses attestation admission only; session-sticker Maintenance decoupling remains incomplete.
