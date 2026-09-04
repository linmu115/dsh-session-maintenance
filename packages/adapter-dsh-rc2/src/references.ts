import type { NativeReferenceResolution, ProjectionRun, StableSessionReference } from "@linmu/dsh-session-adapter-sdk";

import { rc2NativeSessionId } from "./materialize.js";

export function resolveRc2Reference(reference: StableSessionReference, _run: ProjectionRun): NativeReferenceResolution {
  return { logicalSessionId: reference.logicalSessionId, nativeSessionId: rc2NativeSessionId(reference.logicalSessionId), nativeAnchorId: reference.logicalAnchorId, status: "resolved" };
}
