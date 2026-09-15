import { defineAdapterManifest, type AdapterId } from "@linmu/dsh-session-adapter-sdk";
export const manifest = defineAdapterManifest({ schemaVersion: 1, id: "dsh-0.1.5" as AdapterId,
 displayName: "DeepSeek Harness 0.1.5 RC2", adapterApiVersion: 1, packageVersion: "0.1.2",
 testedDshVersions: ["0.1.5-rc.2"], declaredDshRange: "0.1.5-rc.2",
 capabilities: ["session-persistence", "append", "revision-check", "read-from", "workspace-projection", "unknown-event-round-trip", "stable-native-session-id", "deep-link-resolution", "verified-anchor-resolution", "recovery", "projection-verification"] });
