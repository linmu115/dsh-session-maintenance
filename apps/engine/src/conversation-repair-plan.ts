import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { JsonValue, RegisteredInstance } from "@linmu/dsh-session-contracts";
import { canonicalJson, sha256Canonical } from "@linmu/dsh-session-domain";

import type {
  CanonicalImportPlanSessionV1,
  CanonicalImportPlanSummaryV1,
} from "./codex-canonical-import.js";

interface FrozenRepairPlanData {
  readonly format: "mcsf-conversation-repair-plan-v1";
  readonly sourceDatabasePath: string;
  readonly sourceDigest: string;
  readonly currentRevision: number;
  readonly instance: RegisteredInstance;
  readonly summary: CanonicalImportPlanSummaryV1;
  readonly bodies: readonly { readonly logicalSessionId: string; readonly digest: string }[];
}

export interface FrozenRepairPlan {
  readonly path: string;
  readonly digest: string;
  readonly data: FrozenRepairPlanData;
}

function planDirectory(candidatePath: string): string {
  return `${candidatePath}.conversation-plan`;
}

function manifestPath(candidatePath: string): string {
  return join(planDirectory(candidatePath), "plan.json");
}

async function writeExclusive(path: string, text: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

function bytesDigest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The only writes are exclusive files next to the inactive candidate, never in Codex. */
export class RepairPlanWriter {
  private readonly bodies: Array<{ logicalSessionId: string; digest: string }> = [];

  private constructor(private readonly candidatePath: string) {}

  static async create(candidatePath: string): Promise<RepairPlanWriter> {
    // A failed capture stays available for diagnosis; retries use a fresh candidate name.
    await mkdir(planDirectory(candidatePath), { mode: 0o700 });
    return new RepairPlanWriter(candidatePath);
  }

  async capture(item: CanonicalImportPlanSessionV1): Promise<void> {
    const bytes = JSON.stringify(item);
    const digest = bytesDigest(bytes);
    await writeExclusive(join(planDirectory(this.candidatePath), `${digest}.json`), bytes);
    this.bodies.push({ logicalSessionId: item.logicalSessionId, digest });
  }

  async seal(input: Omit<FrozenRepairPlanData, "format" | "bodies">): Promise<FrozenRepairPlan> {
    if (input.summary.retried !== 0 || input.summary.sessions.length !== this.bodies.length) {
      throw new Error("Cannot seal an incomplete Codex repair snapshot");
    }
    const data: FrozenRepairPlanData = {
      format: "mcsf-conversation-repair-plan-v1",
      ...input,
      bodies: this.bodies,
    };
    const digest = sha256Canonical(data as unknown as JsonValue);
    const path = manifestPath(this.candidatePath);
    // Written last: a partial capture cannot be used as a completed plan.
    await writeExclusive(path, canonicalJson({ digest, data } as unknown as JsonValue));
    return { path, digest, data };
  }
}

export async function loadRepairPlan(input: {
  readonly candidatePath: string;
  readonly sourceDatabasePath: string;
  readonly instance: RegisteredInstance;
  readonly expectedDigest: string;
}): Promise<FrozenRepairPlan> {
  const path = manifestPath(input.candidatePath);
  const root = await realpath(dirname(input.candidatePath));
  const directory = await realpath(planDirectory(input.candidatePath));
  if (dirname(directory) !== root || await realpath(path) !== join(directory, "plan.json")) {
    throw new Error("Codex repair snapshot escapes the Maintenance state root");
  }
  const { data, digest } = JSON.parse(await readFile(path, "utf8")) as FrozenRepairPlan;
  if (digest !== input.expectedDigest || sha256Canonical(data as unknown as JsonValue) !== digest) {
    throw new Error("Codex repair snapshot manifest digest does not match the reviewed preview");
  }
  if (data.format !== "mcsf-conversation-repair-plan-v1"
    || resolve(data.sourceDatabasePath) !== resolve(input.sourceDatabasePath)
    || data.instance.id !== input.instance.id
    || data.instance.platform !== "codex"
    || resolve(data.instance.root) !== resolve(input.instance.root)
    || data.instance.platformVersion !== input.instance.platformVersion
    || data.summary.instanceId !== input.instance.id
    || data.summary.retried !== 0
    || data.bodies.length !== data.summary.sessions.length) {
    throw new Error("Codex repair snapshot identity or completeness is invalid");
  }
  const ids = new Set<string>();
  for (const [index, body] of data.bodies.entries()) {
    if (!/^[a-f0-9]{64}$/u.test(body.digest)
      || body.logicalSessionId !== data.summary.sessions[index]?.logicalSessionId
      || ids.has(body.logicalSessionId)) {
      throw new Error("Codex repair snapshot body index is invalid");
    }
    ids.add(body.logicalSessionId);
  }
  return { path, digest, data };
}

/** Hash-check and release one body at a time; no reread of a moving Codex Home. */
export async function visitRepairPlan(
  frozen: FrozenRepairPlan,
  visit: (item: CanonicalImportPlanSessionV1) => Promise<void>,
): Promise<void> {
  const directory = await realpath(dirname(frozen.path));
  for (const [index, body] of frozen.data.bodies.entries()) {
    const path = join(directory, `${body.digest}.json`);
    if (await realpath(path) !== path) throw new Error("Codex repair snapshot body is redirected");
    const bytes = await readFile(path);
    if (bytesDigest(bytes) !== body.digest) {
      throw new Error(`Codex repair snapshot body digest mismatch: ${body.logicalSessionId}`);
    }
    const item = JSON.parse(bytes.toString("utf8")) as CanonicalImportPlanSessionV1;
    const descriptor = frozen.data.summary.sessions[index]!;
    if (item.logicalSessionId !== body.logicalSessionId
      || item.sourceSessionId !== descriptor.sourceSessionId
      || item.sourceCursor !== descriptor.sourceCursor) {
      throw new Error(`Codex repair snapshot body identity mismatch: ${body.logicalSessionId}`);
    }
    await visit(item);
  }
}
