import { defineAdapterManifest, type AdapterId } from "@linmu/dsh-session-adapter-sdk";
import { manifest as base } from "@linmu/dsh-session-adapter-0-1-5";
export const FORMAT_ID = "dsh-gpt-compat-v1-jsonl-zstd";
export const CAPABILITY = "dsh-gpt-compat/session-v1";
export const manifest = defineAdapterManifest({ ...base, id: "dsh-gpt-compat" as AdapterId,
  displayName: "DSH GPT compatibility session v1", packageVersion: "0.1.0" });
export const supportsPluginVersion = (version: string | undefined): boolean =>
  version !== undefined && /^0\.5\.0-dev\.[1-9][0-9]*$/u.test(version);
