import type { SessionFormatEvent } from "@deepseek-ai/dsh-session-format";
import { isRecord } from "./common.js";

/** Title evidence from an already restored prefix, using the RC2 title event contract. */
export interface V3TitleProjection {
  readonly title: string | null;
  readonly eventSeq: number | null;
  readonly throughSeq: number;
}

function validTitle(event: SessionFormatEvent): string | undefined {
  const data = event.data;
  if (event.type !== "session/title" || !isRecord(data)
    || typeof data.title !== "string" || data.title.trim().length === 0
    || !Array.isArray(data.messageSeqs) || !isRecord(data.source)) return undefined;
  const seen = new Set<number>();
  for (const value of data.messageSeqs) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= event.seq || seen.has(value)) return undefined;
    seen.add(value);
  }
  const source = data.source;
  if ((source.kind === "user") !== (data.messageSeqs.length === 0)) return undefined;
  if (source.kind === "provider") {
    if (typeof source.provider !== "string" || source.provider.trim().length === 0) return undefined;
    if (source.model !== undefined && (!isRecord(source.model)
      || typeof source.model.provider !== "string" || source.model.provider.trim().length === 0
      || typeof source.model.model !== "string" || source.model.model.trim().length === 0)) return undefined;
  } else if (source.kind !== "user" && source.kind !== "fallback") return undefined;
  return data.title;
}

/** Invalid informational title payloads retain their original event, but cannot rename a session. */
export function v3TitleProjection(events: readonly SessionFormatEvent[], throughSeq: number): V3TitleProjection {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < -1) throw new TypeError("Invalid title projection cursor");
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq > throughSeq) throw new TypeError("Title event lies outside its verified prefix");
    const title = validTitle(event);
    if (title !== undefined) return { title, eventSeq: event.seq, throughSeq };
  }
  return { title: null, eventSeq: null, throughSeq };
}
