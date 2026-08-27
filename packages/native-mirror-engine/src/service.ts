import { createHash } from "node:crypto";

import {
  SessionMaintenanceError,
  type NativeMirrorActionPreview,
  type NativeMirrorActionRequest,
  type NativeMirrorRecord,
  type NativeMirrorRepository,
  type SessionRepository,
} from "@linmu/dsh-session-contracts";
import { canonicalJson, classifyHeads, VersionGraph } from "@linmu/dsh-session-domain";

type MirrorRepository = SessionRepository & NativeMirrorRepository;

export interface NativeMirrorServiceOptions {
  readonly repository: MirrorRepository;
  readonly clock?: () => string;
}

function operationHash(logicalSessionId: string, request: NativeMirrorActionRequest): string {
  return `sha256:${createHash("sha256").update(canonicalJson({
    logicalSessionId,
    action: request.action,
    ...(request.platform === undefined ? {} : { platform: request.platform }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
  })).digest("hex")}`;
}

export class NativeMirrorService {
  readonly repository: MirrorRepository;
  readonly clock: () => string;

  constructor(options: NativeMirrorServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  list(): Promise<readonly NativeMirrorRecord[]> { return this.repository.listNativeMirrors(); }
  get(logicalSessionId: string): Promise<NativeMirrorRecord | undefined> { return this.repository.getNativeMirror(logicalSessionId); }

  async preview(logicalSessionId: string, request: NativeMirrorActionRequest): Promise<NativeMirrorActionPreview> {
    const mirror = await this.repository.getNativeMirror(logicalSessionId);
    const destructive = request.action === "reset-target" || request.action === "delete-target";
    let allowed = true;
    let message = "该操作只更新 Maintenance 的镜像控制状态。";
    if (["pause", "resume", "keep-branches", "choose-canonical", "unlink"].includes(request.action) && mirror === undefined) {
      allowed = false; message = "该会话尚未启用原生镜像。";
    } else if (request.action === "choose-canonical" && request.platform === undefined) {
      allowed = false; message = "选择规范主线时必须指定 Codex 或 DSH。";
    } else if (destructive) {
      allowed = false;
      message = "当前版本没有可验证的跨平台删除/历史重写 Adapter；为避免伪回退，本操作保持停用。";
    } else if (request.action === "keep-branches") {
      message = "保留两侧分支，不覆盖任何平台，并保持冲突状态。";
    } else if (request.action === "unlink") {
      message = "解除镜像映射但保留两侧会话与全部版本历史。";
    }
    return {
      logicalSessionId,
      action: request.action,
      allowed,
      confirmationRequired: destructive,
      operationHash: operationHash(logicalSessionId, request),
      message,
      ...(mirror === undefined ? {} : { mirror }),
    };
  }

  async apply(logicalSessionId: string, request: NativeMirrorActionRequest): Promise<NativeMirrorRecord> {
    const preview = await this.preview(logicalSessionId, request);
    if (!preview.allowed) {
      throw new SessionMaintenanceError(
        preview.confirmationRequired ? "WRITE_CAPABILITY_UNAVAILABLE" : "MIRROR_NOT_ENABLED",
        preview.message,
      );
    }
    switch (request.action) {
      case "enable":
      case "resume":
        return this.reconcile(logicalSessionId);
      case "pause":
        return this.pause(logicalSessionId, request.reason ?? "用户暂停");
      case "keep-branches":
        return this.keepBranches(logicalSessionId, request.reason ?? "用户选择保留两个分支");
      case "choose-canonical":
        return this.chooseCanonical(logicalSessionId, request.platform!);
      case "unlink": {
        const previous = (await this.repository.getNativeMirror(logicalSessionId))!;
        await this.repository.removeNativeMirror(logicalSessionId);
        await this.repository.setLogicalSessionSyncMode(logicalSessionId, "continuation");
        return { ...previous, state: "disabled", pauseReason: "镜像映射已解除", updatedAt: this.clock() };
      }
      default:
        throw new SessionMaintenanceError("WRITE_CAPABILITY_UNAVAILABLE", "Destructive native mirror action is unavailable");
    }
  }

  async requireWritable(logicalSessionId: string): Promise<NativeMirrorRecord> {
    const mirror = await this.repository.getNativeMirror(logicalSessionId);
    if (mirror === undefined || mirror.state !== "active") {
      throw new SessionMaintenanceError(
        mirror?.state === "conflicted" ? "MIRROR_CONFLICT" : "MIRROR_NOT_ENABLED",
        `Codex native mirror is not active: ${mirror?.state ?? "disabled"}`,
      );
    }
    return mirror;
  }

  async recordCompletedTransaction(logicalSessionId: string, transactionId: string): Promise<NativeMirrorRecord> {
    const reconciled = await this.reconcile(logicalSessionId);
    return this.repository.upsertNativeMirror({ ...reconciled, lastTransactionId: transactionId, updatedAt: this.clock() });
  }

  private async reconcile(logicalSessionId: string): Promise<NativeMirrorRecord> {
    const bindings = await this.repository.listBindings(logicalSessionId);
    const codex = bindings.find((item) => item.key.platform === "codex");
    const dsh = bindings.find((item) => item.key.platform === "dsh");
    if (codex === undefined || dsh === undefined) {
      throw new SessionMaintenanceError("MIRROR_NOT_ENABLED", "原生镜像要求同一逻辑会话已经同时绑定 Codex 与 DSH。请先创建 continuation 并扫描。" );
    }
    const [codexHead, dshHead] = await Promise.all([
      this.repository.getObservedHead(codex.id),
      this.repository.getObservedHead(dsh.id),
    ]);
    if (codexHead === undefined || dshHead === undefined) throw new SessionMaintenanceError("OBJECT_CORRUPT", "Mirror binding head is missing");
    const relation = classifyHeads(new VersionGraph((await this.repository.getGraph(logicalSessionId)).nodes), codexHead.versionId, dshHead.versionId);
    const commonVersionId = relation.kind === "equal"
      ? codexHead.versionId
      : relation.kind === "source-ahead"
        ? dshHead.versionId
        : relation.kind === "target-ahead"
          ? codexHead.versionId
          : relation.kind === "diverged"
            ? relation.mergeBase
            : null;
    const state = relation.kind === "diverged" || relation.kind === "unrelated" ? "conflicted" : "active";
    const record: NativeMirrorRecord = {
      logicalSessionId,
      state,
      codexBindingId: codex.id,
      dshBindingId: dsh.id,
      commonVersionId,
      codexVersionId: codexHead.versionId,
      dshVersionId: dshHead.versionId,
      lastTransactionId: (await this.repository.getNativeMirror(logicalSessionId))?.lastTransactionId ?? null,
      pauseReason: state === "conflicted" ? "两侧都从共同版本继续，必须显式选择冲突处理方式" : null,
      updatedAt: this.clock(),
    };
    await this.repository.setLogicalSessionSyncMode(logicalSessionId, "native-mirror");
    return this.repository.upsertNativeMirror(record);
  }

  private async pause(logicalSessionId: string, reason: string): Promise<NativeMirrorRecord> {
    const mirror = (await this.repository.getNativeMirror(logicalSessionId))!;
    await this.repository.setLogicalSessionSyncMode(logicalSessionId, "paused");
    return this.repository.upsertNativeMirror({ ...mirror, state: "paused", pauseReason: reason, updatedAt: this.clock() });
  }

  private async keepBranches(logicalSessionId: string, reason: string): Promise<NativeMirrorRecord> {
    const mirror = (await this.repository.getNativeMirror(logicalSessionId))!;
    return this.repository.upsertNativeMirror({ ...mirror, state: "conflicted", pauseReason: reason, updatedAt: this.clock() });
  }

  private async chooseCanonical(logicalSessionId: string, platform: "codex" | "dsh"): Promise<NativeMirrorRecord> {
    const mirror = (await this.repository.getNativeMirror(logicalSessionId))!;
    const versionId = platform === "codex" ? mirror.codexVersionId : mirror.dshVersionId;
    if (versionId === null) throw new SessionMaintenanceError("OBJECT_CORRUPT", "Selected mirror head is missing");
    await this.repository.setCanonicalVersion(logicalSessionId, versionId);
    return this.repository.upsertNativeMirror({
      ...mirror,
      state: "conflicted",
      pauseReason: `${platform} 已设为规范主线；另一分支没有被覆盖`,
      updatedAt: this.clock(),
    });
  }
}
