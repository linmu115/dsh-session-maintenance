import type { JsonValue } from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

import { renderHandoff } from "./render.js";
import {
  HandoffError,
  type HandoffBundle,
  type HandoffPreview,
  type HandoffRequest,
} from "./types.js";

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function validate(request: HandoffRequest): void {
  if (!Number.isInteger(request.tokenBudget) || request.tokenBudget <= 0) {
    throw new HandoffError("HANDOFF_REQUEST_INVALID", "tokenBudget must be a positive integer");
  }
  const logicalIds = new Set(request.sources.map((source) => source.manifest.logicalSessionId));
  if (logicalIds.size !== 1) {
    throw new HandoffError("HANDOFF_REQUEST_INVALID", "Handoff sources must belong to the same logical session");
  }
  if (
    request.mode === "checkpoint" &&
    (!Number.isInteger(request.checkpointStartSequence) || request.checkpointStartSequence! < 0)
  ) {
    throw new HandoffError("HANDOFF_REQUEST_INVALID", "Checkpoint mode requires a non-negative start sequence");
  }
  if (
    request.sources.length === 2 &&
    (request.resolution === undefined || request.resolution.mergeNote.trim().length === 0)
  ) {
    throw new HandoffError("HANDOFF_REQUEST_INVALID", "Two-source handoff requires a merge note");
  }
  if (request.sources.length === 1 && request.resolution !== undefined) {
    throw new HandoffError("HANDOFF_REQUEST_INVALID", "Resolution metadata requires two sources");
  }
}

function prepared(request: HandoffRequest): {
  readonly prompt: string;
  readonly preview: HandoffPreview;
} {
  validate(request);
  const rendered = renderHandoff(request);
  const estimatedTokens = estimateTokens(rendered.prompt);
  const allowed = estimatedTokens <= request.tokenBudget;
  return {
    prompt: rendered.prompt,
    preview: {
      mode: request.mode,
      allowed,
      estimatedTokens,
      tokenBudget: request.tokenBudget,
      sourceVersionIds: request.sources.map((source) => source.manifest.id),
      archiveObjectIds: request.sources.map((source) => source.manifest.bodyObject),
      omissions: rendered.omissions,
      ...(allowed ? {} : {
        reason: `Estimated input ${estimatedTokens} exceeds token budget ${request.tokenBudget}`,
      }),
    },
  };
}

export class HandoffBuilder {
  preview(request: HandoffRequest): HandoffPreview {
    return prepared(request).preview;
  }

  build(request: HandoffRequest): HandoffBundle {
    const result = prepared(request);
    if (!result.preview.allowed) {
      throw new HandoffError(
        "HANDOFF_BUDGET_EXCEEDED",
        result.preview.reason ?? "Handoff exceeds token budget",
        result.preview,
      );
    }
    const identity = {
      schemaVersion: 1 as const,
      mode: result.preview.mode,
      prompt: result.prompt,
      tokenBudget: result.preview.tokenBudget,
      sourceVersionIds: result.preview.sourceVersionIds,
      archiveObjectIds: result.preview.archiveObjectIds,
      omissions: result.preview.omissions,
    };
    return {
      ...result.preview,
      schemaVersion: 1,
      id: `handoff_${sha256Canonical(identity as unknown as JsonValue).slice(0, 32)}`,
      allowed: true,
      prompt: result.prompt,
      createdFrom: {
        logicalSessionId: request.sources[0].manifest.logicalSessionId,
        sourceVersionIds: result.preview.sourceVersionIds,
      },
    };
  }
}
