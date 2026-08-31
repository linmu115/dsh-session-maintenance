import { defineAdapterManifest, type AdapterId } from "@linmu/dsh-session-adapter-sdk";

export const manifest = defineAdapterManifest({
  schemaVersion: 1,
  id: "dsh-alpha2" as AdapterId,
  displayName: "DeepSeek Harness 0.1.2 Alpha2",
  adapterApiVersion: 1,
  packageVersion: "0.1.0",
  testedDshVersions: ["0.1.2-alpha.2"],
  declaredDshRange: "*",
  capabilities: [
    "session-persistence",
    "append",
    "revision-check",
    "read-from",
    "borrow-session",
    "workspace-projection",
    "annotation",
    "sticker-obsidian-reference",
    "unknown-event-round-trip",
    "stable-native-session-id",
    "deep-link-resolution",
    "projection-verification",
  ],
});
