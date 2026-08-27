import type { JsonValue } from "./model.js";

export type ContinuationMode = "full" | "checkpoint" | "structured-summary";
export type ContinuationJobStatus =
  | "prepared"
  | "creating"
  | "started"
  | "verifying"
  | "completed"
  | "failed"
  | "manual-review";

export interface CodexContinuationTarget {
  readonly id: string;
  readonly codexInstanceId: string;
  readonly platformVersion: string;
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly contextWindowTokens: number;
  readonly inputBudgetRatio: number;
  readonly model?: string;
  readonly permissions?: string;
  readonly codexHome?: string;
  readonly command?: string;
}

export interface ContinuationPreviewRequest {
  readonly logicalSessionId: string;
  readonly sourceVersionId: string;
  readonly targetPresetId: string;
  readonly mode: ContinuationMode;
  readonly checkpointStartSequence?: number;
}

export interface ResolutionContinuationRequest {
  readonly logicalSessionId: string;
  readonly leftVersionId: string;
  readonly rightVersionId: string;
  readonly commonAncestorVersionId?: string;
  readonly mergeNote: string;
  readonly targetPresetId: string;
  readonly mode: ContinuationMode;
  readonly checkpointStartSequence?: number;
}

export type CreateContinuationRequest = ContinuationPreviewRequest;

export interface ContinuationPreview {
  readonly mode: ContinuationMode;
  readonly allowed: boolean;
  readonly estimatedTokens: number;
  readonly tokenBudget: number;
  readonly sourceVersionIds: readonly string[];
  readonly archiveObjectIds: readonly string[];
  readonly omissions: readonly {
    readonly sourceVersionId: string;
    readonly reason: "checkpoint" | "structured-summary";
    readonly eventCount: number;
    readonly characterCount: number;
  }[];
  readonly reason?: string;
}

export interface ContinuationJob {
  readonly id: string;
  readonly requestHash: string;
  readonly request: CreateContinuationRequest | ResolutionContinuationRequest;
  readonly logicalSessionId: string;
  readonly sourceVersionIds: readonly string[];
  readonly targetPresetId: string;
  readonly mode: ContinuationMode;
  readonly handoffObjectId: string;
  readonly status: ContinuationJobStatus;
  readonly codexThreadId?: string;
  readonly codexTurnId?: string;
  readonly errorCode?: string;
  readonly verification?: JsonValue;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContinuationTransition {
  readonly expected: readonly ContinuationJobStatus[];
  readonly status: ContinuationJobStatus;
  readonly updatedAt: string;
  readonly codexThreadId?: string;
  readonly codexTurnId?: string;
  readonly errorCode?: string;
  readonly verification?: JsonValue;
}

export interface ContinuationProbe {
  readonly status: "compatible" | "unsupported";
  readonly platformVersion: string;
  readonly schemaFingerprint: string;
  readonly capabilities: readonly ("create-thread" | "start-turn" | "read-thread")[];
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

export interface CreatedCodexThread {
  readonly threadId: string;
  readonly turnId: string;
  readonly status: "turn-completed";
  readonly cwd: string;
}

export interface ContinuationVerification {
  readonly ok: true;
  readonly threadId: string;
  readonly cwd: string;
  readonly historyMode: "paginated";
}

export interface CodexContinuationPort {
  probe(target: CodexContinuationTarget): Promise<ContinuationProbe>;
  create(input: {
    readonly prompt: string;
    readonly target: CodexContinuationTarget;
    readonly onThreadStarted?: (threadId: string) => Promise<void>;
  }): Promise<CreatedCodexThread>;
  verify(
    created: Pick<CreatedCodexThread, "threadId">,
    target: CodexContinuationTarget,
  ): Promise<ContinuationVerification>;
  close(): Promise<void>;
}

export interface ContinuationEngine {
  previewContinuation(request: ContinuationPreviewRequest): Promise<ContinuationPreview>;
  createContinuation(request: CreateContinuationRequest): Promise<ContinuationJob>;
  getContinuation(id: string): Promise<ContinuationJob | undefined>;
  recoverContinuation(id: string): Promise<ContinuationJob>;
}
