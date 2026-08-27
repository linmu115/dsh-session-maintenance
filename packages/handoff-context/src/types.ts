import type { NormalizedSession, SessionVersionManifest } from "@linmu/dsh-session-contracts";

export type HandoffMode = "full" | "checkpoint" | "structured-summary";

export interface HandoffSource {
  readonly manifest: SessionVersionManifest;
  readonly session: NormalizedSession;
}

export interface HandoffResolution {
  readonly commonAncestorVersionId?: string;
  readonly mergeNote: string;
}

export interface HandoffRequest {
  readonly sources: readonly [HandoffSource] | readonly [HandoffSource, HandoffSource];
  readonly mode: HandoffMode;
  readonly tokenBudget: number;
  readonly checkpointStartSequence?: number;
  readonly resolution?: HandoffResolution;
}

export interface HandoffOmission {
  readonly sourceVersionId: string;
  readonly reason: "checkpoint" | "structured-summary";
  readonly eventCount: number;
  readonly characterCount: number;
}

export interface HandoffPreview {
  readonly mode: HandoffMode;
  readonly allowed: boolean;
  readonly estimatedTokens: number;
  readonly tokenBudget: number;
  readonly sourceVersionIds: readonly string[];
  readonly archiveObjectIds: readonly string[];
  readonly omissions: readonly HandoffOmission[];
  readonly reason?: string;
}

export interface HandoffBundle extends HandoffPreview {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly allowed: true;
  readonly prompt: string;
  readonly createdFrom: {
    readonly logicalSessionId: string;
    readonly sourceVersionIds: readonly string[];
  };
}

export class HandoffError extends Error {
  readonly code: "HANDOFF_BUDGET_EXCEEDED" | "HANDOFF_REQUEST_INVALID";
  readonly preview: HandoffPreview | undefined;

  constructor(
    code: "HANDOFF_BUDGET_EXCEEDED" | "HANDOFF_REQUEST_INVALID",
    message: string,
    preview?: HandoffPreview,
  ) {
    super(message);
    this.name = "HandoffError";
    this.code = code;
    this.preview = preview;
  }
}
