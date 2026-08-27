import {
  SessionMaintenanceError,
  type JsonValue,
} from "@linmu/dsh-session-contracts";
import { sha256Canonical } from "@linmu/dsh-session-domain";

import { assessRc2CoreContract, RC2_CORE_CONTRACT_FINGERPRINT } from "./contract.js";
import type {
  DshCoreApplyRequest,
  DshCoreCaptureRequest,
  DshCoreExtension,
  DshCoreHost,
  DshCoreProbe,
  DshCoreRestoreRequest,
  DshCoreSnapshot,
  DshCoreState,
  DshProjectionSnapshot,
  DshRuntimeSnapshot,
  DshSessionArtifactSnapshot,
  DshWorkspaceSnapshot,
} from "./types.js";

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function statePayload(input: {
  readonly sessionId: string;
  readonly contractFingerprint: string;
  readonly session: DshSessionArtifactSnapshot;
  readonly workspace: DshWorkspaceSnapshot;
  readonly projection: DshProjectionSnapshot;
  readonly runtime: DshRuntimeSnapshot;
}): Omit<DshCoreState, "digest"> {
  return {
    sessionId: input.sessionId,
    contractFingerprint: input.contractFingerprint,
    sessionRevision: input.session.exists ? input.session.revision : null,
    sessionArtifactHash: input.session.exists
      ? sha256Canonical(input.session.artifact as unknown as JsonValue)
      : null,
    eventCount: input.session.exists ? input.session.events.length : 0,
    workspaceId: input.workspace.workspaceId,
    workspaceMemberIndex: input.workspace.memberIndex,
    archived: input.workspace.archived,
    projectionHash: input.projection.present
      ? sha256Canonical(input.projection.record)
      : null,
    coordinator: input.runtime.coordinator,
    queryIndex: input.runtime.queryIndex,
  };
}

function stateOf(input: Parameters<typeof statePayload>[0]): DshCoreState {
  const payload = statePayload(input);
  const stable = {
    sessionId: payload.sessionId,
    contractFingerprint: payload.contractFingerprint,
    sessionArtifactHash: payload.sessionArtifactHash,
    eventCount: payload.eventCount,
    workspaceId: payload.workspaceId,
    workspaceMemberIndex: payload.workspaceMemberIndex,
    archived: payload.archived,
    projectionHash: payload.projectionHash,
    coordinator: payload.coordinator,
    queryIndex: payload.queryIndex,
  };
  return { ...payload, digest: sha256Canonical(stable as unknown as JsonValue) };
}

function snapshotPayload(snapshot: Omit<DshCoreSnapshot, "hash">): JsonValue {
  return snapshot as unknown as JsonValue;
}

function snapshotHash(snapshot: Omit<DshCoreSnapshot, "hash">): string {
  return `sha256:${sha256Canonical(snapshotPayload(snapshot))}`;
}

export class LockedRc2CoreExtension implements DshCoreExtension {
  readonly host: DshCoreHost;
  private readonly sessionTails = new Map<string, Promise<void>>();

  constructor(host: DshCoreHost) {
    this.host = host;
  }

  async probe(): Promise<DshCoreProbe> {
    return assessRc2CoreContract(await this.host.observeContract());
  }

  async capture(request: DshCoreCaptureRequest): Promise<DshCoreSnapshot> {
    const contractFingerprint = await this.assertCompatible();
    this.assertCold(request.sessionId);
    const [rawSession, workspace, projection, runtime] = await Promise.all([
      this.host.captureSession(request.sessionId),
      this.host.captureWorkspace(request.sessionId, request.workspaceId),
      this.host.captureProjection(request.sessionId),
      this.host.captureRuntime(request.sessionId),
    ]);
    const session = { sessionId: request.sessionId, ...rawSession } as DshSessionArtifactSnapshot;
    if (session.exists && (session.header.id !== request.sessionId || session.header.version !== 0)) {
      throw new SessionMaintenanceError(
        "IDENTITY_CONFLICT",
        `DSH Core snapshot changed session identity: ${request.sessionId}`,
      );
    }
    const before = stateOf({
      sessionId: request.sessionId,
      contractFingerprint,
      session,
      workspace,
      projection,
      runtime,
    });
    const payload: Omit<DshCoreSnapshot, "hash"> = {
      schemaVersion: 1,
      instanceId: request.instanceId,
      sessionId: request.sessionId,
      contractFingerprint,
      session: jsonClone(session),
      workspace: jsonClone(workspace),
      projection: jsonClone(projection),
      runtime: jsonClone(runtime),
      before,
    };
    return { ...payload, hash: snapshotHash(payload) };
  }

  async apply(request: DshCoreApplyRequest): Promise<DshCoreState> {
    return this.withSessionLock(request.snapshot.sessionId, () => this.applyLocked(request));
  }

  private async applyLocked(request: DshCoreApplyRequest): Promise<DshCoreState> {
    await this.assertSnapshot(request.snapshot);
    this.assertCold(request.snapshot.sessionId);
    const current = await this.capture({
      instanceId: request.snapshot.instanceId,
      sessionId: request.snapshot.sessionId,
      ...(request.snapshot.workspace.workspaceId === null
        ? {}
        : { workspaceId: request.snapshot.workspace.workspaceId }),
    });
    if (current.before.digest !== request.snapshot.before.digest) {
      throw new SessionMaintenanceError("PLAN_STALE", "DSH Core state changed after capture");
    }
    this.assertCapturedRevision(current, request.snapshot);

    const sessionId = request.snapshot.sessionId;
    if (request.header !== undefined) {
      if (request.header.id !== sessionId || request.header.version !== 0) {
        throw new SessionMaintenanceError("IDENTITY_CONFLICT", "Prepared DSH header identity is invalid");
      }
      if (request.snapshot.session.exists) {
        throw new SessionMaintenanceError("PLAN_STALE", `DSH session already exists: ${sessionId}`);
      }
      await this.host.createSession(request.header);
    } else if (!request.snapshot.session.exists && request.events.length > 0) {
      throw new SessionMaintenanceError(
        "WRITE_CAPABILITY_UNAVAILABLE",
        `Cannot append to an absent DSH session: ${sessionId}`,
      );
    }

    this.assertContiguousEvents(request);
    if (request.events.length > 0) await this.host.appendEvents(sessionId, request.events);

    const workspaceId = request.workspaceId ?? request.snapshot.workspace.workspaceId;
    if (workspaceId !== null && workspaceId !== undefined && request.snapshot.workspace.memberIndex === null) {
      await this.host.attachWorkspace(sessionId, workspaceId);
    }
    if (
      request.archived !== undefined &&
      request.archived !== request.snapshot.workspace.archived
    ) {
      await this.host.setArchive(sessionId, request.archived);
    }
    if (request.events.length > 0 || request.header !== undefined) {
      await this.host.invalidateProjection(sessionId);
    }
    await this.host.reconcileRuntime(sessionId);
    return this.observeState(request.snapshot.instanceId, sessionId, workspaceId);
  }

  async restore(request: DshCoreRestoreRequest): Promise<DshCoreState> {
    return this.withSessionLock(request.snapshot.sessionId, () => this.restoreLocked(request));
  }

  private async restoreLocked(request: DshCoreRestoreRequest): Promise<DshCoreState> {
    await this.assertSnapshot(request.snapshot);
    this.assertCold(request.snapshot.sessionId);
    await this.host.restoreSession(request.snapshot.session);
    await this.host.restoreWorkspace(request.snapshot.sessionId, request.snapshot.workspace);
    await this.host.restoreProjection(request.snapshot.sessionId, request.snapshot.projection);
    await this.host.reconcileRuntime(request.snapshot.sessionId);
    const state = await this.observeState(
      request.snapshot.instanceId,
      request.snapshot.sessionId,
      request.snapshot.workspace.workspaceId,
    );
    if (state.digest !== request.snapshot.before.digest) {
      throw new SessionMaintenanceError("RESTORE_FAILED", "DSH Core restore digest mismatch", {
        details: { expected: request.snapshot.before.digest, actual: state.digest },
      });
    }
    return state;
  }

  private async observeState(
    instanceId: string,
    sessionId: string,
    workspaceId: string | null | undefined,
  ): Promise<DshCoreState> {
    const contractFingerprint = await this.assertCompatible();
    const [rawSession, workspace, projection, runtime] = await Promise.all([
      this.host.captureSession(sessionId),
      this.host.captureWorkspace(sessionId, workspaceId ?? undefined),
      this.host.captureProjection(sessionId),
      this.host.captureRuntime(sessionId),
    ]);
    const session = { sessionId, ...rawSession } as DshSessionArtifactSnapshot;
    void instanceId;
    return stateOf({ sessionId, contractFingerprint, session, workspace, projection, runtime });
  }

  private async assertCompatible(): Promise<string> {
    const probe = await this.probe();
    if (
      probe.status !== "compatible" ||
      probe.contractFingerprint !== RC2_CORE_CONTRACT_FINGERPRINT
    ) {
      throw new SessionMaintenanceError(
        "ADAPTER_INCOMPATIBLE",
        "DSH Core extension contract does not match official 0.1.1-rc.2",
      );
    }
    return probe.contractFingerprint;
  }

  private async assertSnapshot(snapshot: DshCoreSnapshot): Promise<void> {
    const { hash, ...payload } = snapshot;
    if (snapshot.schemaVersion !== 1 || hash !== snapshotHash(payload)) {
      throw new SessionMaintenanceError("BACKUP_CORRUPT", "DSH Core snapshot hash mismatch");
    }
    const contract = await this.assertCompatible();
    if (snapshot.contractFingerprint !== contract) {
      throw new SessionMaintenanceError("ADAPTER_INCOMPATIBLE", "DSH Core snapshot contract drifted");
    }
  }

  private assertCold(sessionId: string): void {
    if (this.host.isSessionLive(sessionId)) {
      throw new SessionMaintenanceError("DSH_BUSY", `DSH session is live: ${sessionId}`);
    }
  }

  private assertContiguousEvents(request: DshCoreApplyRequest): void {
    const expected = request.snapshot.session.exists ? request.snapshot.session.events.length : 0;
    for (const [index, event] of request.events.entries()) {
      if (event.seq !== expected + index) {
        throw new SessionMaintenanceError(
          "WRITE_CAPABILITY_UNAVAILABLE",
          `DSH event sequence is not contiguous: expected ${expected + index}, got ${event.seq}`,
        );
      }
    }
  }

  private assertCapturedRevision(current: DshCoreSnapshot, expected: DshCoreSnapshot): void {
    if (current.session.exists !== expected.session.exists) {
      throw new SessionMaintenanceError("PLAN_STALE", "DSH session existence changed after capture");
    }
    if (
      current.session.exists &&
      expected.session.exists &&
      current.session.revision !== expected.session.revision
    ) {
      throw new SessionMaintenanceError("PLAN_STALE", "DSH session revision changed after capture");
    }
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    this.sessionTails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    }
  }
}
