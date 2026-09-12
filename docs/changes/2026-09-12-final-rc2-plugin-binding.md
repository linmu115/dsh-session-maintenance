# Final RC2 plugin binding

The final paired Engine uses Maintenance plugin 0.2.25-rc2.2, whose gateway bundle includes the completed native conversion and portable resource changes. RC2 discovery now requires this exact plugin version. The older rc2.1 bundle cannot satisfy final RC2 onboarding; runtime attestation and package closure checks still apply independently.

Validation: focused integration discovery regression checks rejection of rc2.1, recognition of rc2.2, and continued refusal without runtime attestation.

Adopting an existing global Launcher hook preserves its strict or legacy admission mode, so unrelated old instances retain their current behavior. New hooks still default to strict admission. The connected target has a separate required policy and refuses startup after loss of its binding in either global mode. The existing trace-wrapper regression covers preserved legacy mode and required-target refusal.
