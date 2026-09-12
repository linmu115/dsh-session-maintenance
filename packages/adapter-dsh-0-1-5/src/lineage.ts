import { assertReleasedV3Header } from "@deepseek-ai/dsh-session-format-v2-to-v3";
import type { SessionFormatHeader } from "@deepseek-ai/dsh-session-format";
import { count, record } from "./common.js";
export function parseV3LogicalSessionHeader(value: unknown, expectedId: string, description = "V3 header"): SessionFormatHeader {
 const header = record(value, description); assertReleasedV3Header(header as unknown as import("./native-types.js").V3Header);
 if (header.id !== expectedId) throw new TypeError(`${description} identity mismatch`);
 return header as SessionFormatHeader;
}
export function parseV3RegistrationMetadata(value: unknown): number { return count(record(value).inheritedEventCount, "inheritedEventCount"); }
export function validateV3Lineage(header: SessionFormatHeader, inherited: number): void {
 count(inherited, "inheritedEventCount"); if (!header.isSeeded && inherited !== 0) throw new TypeError("Unseeded V3 session has inherited events");
}
