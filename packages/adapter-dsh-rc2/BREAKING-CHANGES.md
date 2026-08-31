# DSH RC2 breaking changes handled

This adapter isolates the pre-Alpha2 persistence seam used by DeepSeek Harness `0.1.1-rc.2`.

- RC2 stores a version-0 `session` header with `cwd` and `delegationDepth`; Alpha2 runtime objects cannot be inserted directly.
- RC2 persistence is attached through the package-local `legacySessionPersistence` hook. No deleted Client Runtime import is used.
- Events retain RC2 `type`, `seq`, `time` and `data` envelopes. Unknown plugin events are held out and round-tripped, never converted into private `session/imported` events.
- Logical workspace IDs are converted to temporary RC2 `projectId` values only inside the projection.
- Annotation, Sticker and Obsidian links resolve from stable logical IDs for the current run; old native IDs remain historical aliases.
- Profile Homes receive only temporary projection state. Canonical content remains owned by Maintenance.
