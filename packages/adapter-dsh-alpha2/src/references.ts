import type {
  NativeReferenceResolution,
  ProjectionRun,
  StableSessionReference,
} from "@linmu/dsh-session-adapter-sdk";

import { alpha2NativeSessionId } from "./materialize.js";

export function resolveAlpha2Reference(
  reference: StableSessionReference,
  _run: ProjectionRun,
): NativeReferenceResolution {
  return {
    logicalSessionId: reference.logicalSessionId,
    nativeSessionId: alpha2NativeSessionId(reference.logicalSessionId),
    nativeAnchorId: reference.logicalAnchorId,
    status: "resolved",
  };
}
