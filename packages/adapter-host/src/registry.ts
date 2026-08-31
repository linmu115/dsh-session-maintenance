import type {
  AdapterId,
  AdapterManifestV1,
  AdapterProbeResult,
  DshEnvironmentDescriptor,
  JsonValue,
} from "@linmu/dsh-session-contracts";
import { defineAdapterManifest } from "@linmu/dsh-session-adapter-sdk";
import type { SqliteAdapterRegistryRepository } from "@linmu/dsh-session-store";

import type { AdapterHost } from "./host.js";

export type AdapterRegistrationSource =
  | { readonly kind: "npm"; readonly packageName: string; readonly entryPoint: string }
  | { readonly kind: "local"; readonly directory: string; readonly entryPoint: string }
  | { readonly kind: "generation"; readonly generationId: string; readonly packageName: string; readonly entryPoint: string };

export interface AdapterRegistration {
  readonly manifest: AdapterManifestV1;
  readonly source: AdapterRegistrationSource;
  readonly enabled: boolean;
}

export type AdapterSelectionReason = "pinned" | "verified" | "probe-compatible" | "experimental";

export interface AdapterSelection {
  readonly adapterId: AdapterId;
  readonly registration: AdapterRegistration;
  readonly probe: AdapterProbeResult;
  readonly reason: AdapterSelectionReason;
  readonly verificationRunId: string;
}

interface Evaluation {
  readonly registration: AdapterRegistration;
  readonly probe: AdapterProbeResult;
  readonly verificationRunId: string;
}

function sourceLocation(source: AdapterRegistrationSource): string {
  if (source.kind === "npm") return `npm:${source.packageName}#${source.entryPoint}`;
  if (source.kind === "local") return `local:${source.directory}#${source.entryPoint}`;
  return `generation:${source.generationId}:${source.packageName}#${source.entryPoint}`;
}

function reasonFor(status: AdapterProbeResult["status"]): AdapterSelectionReason {
  if (status === "verified") return "verified";
  if (status === "compatible") return "probe-compatible";
  return "experimental";
}

export class AdapterRegistry {
  readonly host: AdapterHost;
  readonly repository: SqliteAdapterRegistryRepository;
  private readonly registrations = new Map<string, AdapterRegistration>();
  private readonly now: () => string;
  private readonly verificationId: () => string;

  constructor(input: {
    readonly host: AdapterHost;
    readonly repository: SqliteAdapterRegistryRepository;
    readonly now?: () => string;
    readonly verificationId?: () => string;
  }) {
    this.host = input.host;
    this.repository = input.repository;
    this.now = input.now ?? (() => new Date().toISOString());
    let sequence = 0;
    this.verificationId = input.verificationId ?? (() => `adapter-verification-${Date.now()}-${++sequence}`);
  }

  async register(input: AdapterRegistration): Promise<void> {
    const manifest = defineAdapterManifest(input.manifest);
    if (input.source.entryPoint.length === 0) throw new TypeError("Adapter registration requires an entry point");
    const registration = { ...input, manifest };
    this.registrations.set(manifest.id, registration);
    const now = this.now();
    await this.repository.upsertRegistration({
      manifest,
      packageLocation: sourceLocation(input.source),
      enabled: input.enabled,
      registeredAt: now,
      updatedAt: now,
    });
  }

  list(): readonly AdapterRegistration[] {
    return [...this.registrations.values()].sort((left, right) =>
      left.manifest.id.localeCompare(right.manifest.id)
    );
  }

  async select(input: {
    readonly environment: DshEnvironmentDescriptor;
    readonly pinnedAdapterId?: AdapterId;
  }): Promise<AdapterSelection> {
    const evaluations: Evaluation[] = [];
    for (const registration of this.list().filter((item) => item.enabled)) {
      const probe = await this.host.probe(registration, input.environment);
      const verificationRunId = this.verificationId();
      const evaluation = { registration, probe, verificationRunId };
      evaluations.push(evaluation);
      await this.saveEvaluation(evaluation, null, input.environment.dshVersion);
    }
    const selectable = evaluations.filter((item) => item.probe.status !== "failed");
    let chosen: Evaluation | undefined;
    let reason: AdapterSelectionReason;
    if (input.pinnedAdapterId !== undefined) {
      chosen = selectable.find((item) => item.registration.manifest.id === input.pinnedAdapterId);
      if (chosen === undefined) throw new Error(`Pinned Adapter is unavailable: ${input.pinnedAdapterId}`);
      reason = "pinned";
    } else {
      const rank = { verified: 0, compatible: 1, experimental: 2 } as const;
      chosen = selectable.sort((left, right) =>
        rank[left.probe.status as keyof typeof rank] - rank[right.probe.status as keyof typeof rank] ||
        left.registration.manifest.id.localeCompare(right.registration.manifest.id)
      )[0];
      if (chosen === undefined) throw new Error("No Adapter passed runtime capability probing");
      reason = reasonFor(chosen.probe.status);
    }
    await this.saveEvaluation(chosen, reason, input.environment.dshVersion);
    return {
      adapterId: chosen.registration.manifest.id,
      registration: chosen.registration,
      probe: chosen.probe,
      reason,
      verificationRunId: chosen.verificationRunId,
    };
  }

  private async saveEvaluation(
    evaluation: Evaluation,
    reason: AdapterSelectionReason | null,
    dshVersion: string,
  ): Promise<void> {
    const now = this.now();
    await this.repository.saveVerificationRun({
      id: evaluation.verificationRunId,
      adapterId: evaluation.registration.manifest.id,
      dshVersion,
      status: evaluation.probe.status,
      result: {
        adapterId: evaluation.registration.manifest.id,
        status: evaluation.probe.status,
        reason,
        issueCodes: evaluation.probe.issues.map((issue) => issue.code),
      } as JsonValue,
      startedAt: now,
      completedAt: now,
    });
  }
}
