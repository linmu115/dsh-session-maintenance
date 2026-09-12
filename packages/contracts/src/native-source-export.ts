/** Transport digest contract. Canonical objects and persisted evidence keep their own digests. */
export const NATIVE_SOURCE_EXPORT_DIGEST_ALGORITHM = "sha256-json-utf16-v1" as const;

/** JSON object keys use ECMAScript UTF-16 order; never the machine locale. Array order is significant. */
export function serializeNativeSourceExport(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}
