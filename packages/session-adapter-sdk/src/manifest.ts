import {
  adapterManifestV1Schema,
  type AdapterManifestV1,
  type CompatibilityIssue,
} from "@linmu/dsh-session-contracts";

export type AdapterManifestNegotiation =
  | {
      readonly ok: true;
      readonly status: "verified" | "compatible" | "experimental";
      readonly manifest: AdapterManifestV1;
      readonly issues: readonly CompatibilityIssue[];
    }
  | {
      readonly ok: false;
      readonly status: "failed";
      readonly issues: readonly CompatibilityIssue[];
    };

export function defineAdapterManifest(input: AdapterManifestV1): AdapterManifestV1 {
  return adapterManifestV1Schema.parse(input) as unknown as AdapterManifestV1;
}

export function negotiateAdapterManifest(input: unknown): AdapterManifestNegotiation {
  if (typeof input === "object" && input !== null && "adapterApiVersion" in input) {
    const major = (input as { readonly adapterApiVersion?: unknown }).adapterApiVersion;
    if (major !== 1) {
      return {
        ok: false,
        status: "failed",
        issues: [{
          code: "ADAPTER_API_UNSUPPORTED",
          message: `Adapter API major ${String(major)} is not supported; this Core accepts major 1`,
        }],
      };
    }
  }
  const parsed = adapterManifestV1Schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: "failed",
      issues: [{
        code: "ADAPTER_MANIFEST_INVALID",
        message: "Adapter manifest does not match the version 1 contract",
      }],
    };
  }
  return {
    ok: true,
    status: parsed.data.testedDshVersions.length === 0 ? "experimental" : "compatible",
    manifest: parsed.data as unknown as AdapterManifestV1,
    issues: [],
  };
}
