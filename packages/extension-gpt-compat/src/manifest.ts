/** Extension identity is independent of the DSH Harness and framing format. */
export const NAMESPACE = "gpt-compat";
export const WRITER_ID = "maintenance-gpt-compat-index";
export const CAPABILITY = "dsh-gpt-compat/session-v1";
export const PLUGIN_VERSIONS = ["0.5.0-dev.1", "0.5.0-dev.2", "0.5.0-dev.3", "0.5.0-dev.4","0.5.0-dev.5", "0.5.0-dev.6", "0.5.0-dev.7", "0.5.0-dev.8"] as const;
export const supportsPluginVersion = (version: string | undefined): boolean =>
  version !== undefined && (PLUGIN_VERSIONS as readonly string[]).includes(version);
export { manifest } from "@linmu/dsh-session-adapter-0-1-5";
export const FORMAT_ID = "dsh-0.1.5-v3-jsonl-zstd-v1";
