import type {
  NativeReferenceResolution,
  ProjectionRun,
  StableSessionReference,
} from "@linmu/dsh-session-adapter-sdk";

import { rc1NativeSessionId } from "./materialize.js";

export function resolveRc1Reference(
  reference: StableSessionReference,
  _run: ProjectionRun,
): NativeReferenceResolution {
  return {
    logicalSessionId: reference.logicalSessionId,
    nativeSessionId: rc1NativeSessionId(reference.logicalSessionId),
    nativeAnchorId: reference.logicalAnchorId,
    status: "resolved",
  };
}
