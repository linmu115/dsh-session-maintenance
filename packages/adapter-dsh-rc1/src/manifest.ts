import { defineAdapterManifest, type AdapterId } from "@linmu/dsh-session-adapter-sdk";

export const manifest = defineAdapterManifest({
  schemaVersion: 1,
  id: "dsh-rc1" as AdapterId,
  displayName: "DeepSeek Harness 0.1.2 RC1",
  adapterApiVersion: 1,
  packageVersion: "0.1.2",
  testedDshVersions: ["0.1.2-rc.1"],
  declaredDshRange: "0.1.2-rc.1",
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
    "verified-anchor-resolution",
    "projection-verification",
  ],
});
