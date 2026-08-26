import { isDeepStrictEqual } from "node:util";

import type { NormalizedEvent } from "@linmu/dsh-session-contracts";

export type ConversationDelta = "unchanged" | "append-only" | "rewritten";
export type MetadataDelta = "unchanged" | "source-only" | "target-only" | "metadata-conflict";

export interface SessionMetadata {
  readonly title: string;
  readonly archived: boolean;
}

export function classifyConversationDelta(
  base: readonly NormalizedEvent[],
  current: readonly NormalizedEvent[],
): ConversationDelta {
  if (base.length === current.length && isDeepStrictEqual(base, current)) {
    return "unchanged";
  }
  if (current.length < base.length) {
    return "rewritten";
  }

  for (let index = 0; index < base.length; index += 1) {
    if (!isDeepStrictEqual(base[index], current[index])) {
      return "rewritten";
    }
  }

  return "append-only";
}

function sameMetadata(left: SessionMetadata, right: SessionMetadata): boolean {
  return left.title === right.title && left.archived === right.archived;
}

export function classifyMetadataDelta(
  base: SessionMetadata,
  source: SessionMetadata,
  target: SessionMetadata,
): MetadataDelta {
  if (sameMetadata(source, target)) {
    return "unchanged";
  }
  if (sameMetadata(base, source)) {
    return "target-only";
  }
  if (sameMetadata(base, target)) {
    return "source-only";
  }
  return "metadata-conflict";
}
