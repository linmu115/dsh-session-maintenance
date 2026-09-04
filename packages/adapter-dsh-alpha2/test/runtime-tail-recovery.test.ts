import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { constants, zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";
import type {
  LogicalSessionId,
  NativeSessionId,
  RunId,
  SessionVersionId,
} from "@linmu/dsh-session-contracts";

import {
  Alpha2RuntimeTailRecoveryError,
  isAlpha2PreparationOnlyAppend,
  recoverAlpha2RuntimeTail,
  type Alpha2CommittedRuntimeSession,
} from "../src/runtime-tail-recovery.js";

const runId = "run-alpha2-tail-fixture" as RunId;
const nativeSessionId = "native-alpha2-tail-fixture" as NativeSessionId;
const logicalSessionId = "logical-alpha2-tail-fixture" as LogicalSessionId;
const baseVersionId = "version-alpha2-tail-fixture" as SessionVersionId;
const observedAt = "2026-09-01T12:00:00.000Z";
const header = {
  version: 0,
  id: nativeSessionId,
  createdAt: 1_788_256_800_000,
  cwd: "C:/synthetic/project",
  delegationDepth: 0,
} as const;
const first = {
  type: "user/message",
  seq: 0,
  time: 1_788_256_800_001,
  data: { text: "synthetic" },
} as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function mapping(overrides: Partial<Alpha2CommittedRuntimeSession> = {}): Alpha2CommittedRuntimeSession {
  return {
    nativeSessionId,
    logicalSessionId,
    baseVersionId,
    nativeRevision: 1,
    header,
    committedEvents: [first],
    instanceId: "alpha2-synthetic",
    ...overrides,
  };
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-maint-alpha2-runtime-tail-fixture-"));
  roots.push(root);
  return root;
}

function eventFrame(events: readonly unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  });
}

async function writeArtifact(
  root: string,
  rows: readonly unknown[],
  options: { readonly compression?: "none" | "zstd"; readonly header?: unknown } = {},
): Promise<string> {
  const directory = join(root, "--C-synthetic-project--", nativeSessionId);
  await mkdir(directory, { recursive: true });
  const storageHeader = { type: "session", ...(options.header ?? header as object) };
  if ((options.compression ?? "zstd") === "none") {
    const path = join(directory, "session.jsonl");
    await writeFile(path, `${JSON.stringify(storageHeader)}\n${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length === 0 ? "" : "\n"}`);
    return path;
  }
  const path = join(directory, "session.jsonl.zstd");
  const frames = [eventFrame([storageHeader]), ...(rows.length === 0 ? [] : [eventFrame(rows)])];
  await writeFile(path, Buffer.concat(frames));
  return path;
}

async function recover(root: string, sessions: readonly Alpha2CommittedRuntimeSession[] = [mapping()]) {
  return recoverAlpha2RuntimeTail({ runId, persistenceRoot: root, sessions, observedAt });
}

describe("recoverAlpha2RuntimeTail", () => {
  it("classifies only pure Alpha2 restore-preparation WAL appends as supersedable", () => {
    const operation = {
      runId,
      operationId: "operation-prelude" as never,
      nativeSessionId,
      nativeRevision: 3,
      observedAt,
      payload: {
        logicalSessionId,
        baseVersionId,
        events: [
          { type: "permission/preset", seq: 1, time: first.time + 1, data: { preset: "default" } },
          { type: "sandbox/mode", seq: 2, time: first.time + 2, data: { mode: "workspace-write" } },
        ],
      },
    } as const;

    expect(isAlpha2PreparationOnlyAppend(operation)).toBe(true);
    expect(isAlpha2PreparationOnlyAppend({
      ...operation,
      nativeRevision: 4,
      payload: {
        ...operation.payload,
        events: [
          ...operation.payload.events,
          { type: "user/message", seq: 3, time: first.time + 3, data: { text: "continue" } },
        ],
      },
    })).toBe(false);
  });

  it("treats an unmaterialized lazy session as having no runtime tail", async () => {
    const root = await fixtureRoot();
    await expect(recover(root, [mapping({
      header: { version: 0, id: nativeSessionId, createdAt: header.createdAt, cwd: header.cwd },
    })])).resolves.toEqual([]);
  });

  it("ignores an unmapped preparation-only composer shell but rejects an unmapped real continuation", async () => {
    const emptyRoot = await fixtureRoot();
    await writeArtifact(emptyRoot, []);
    const ignored: NativeSessionId[] = [];
    await expect(recoverAlpha2RuntimeTail({
      runId,
      persistenceRoot: emptyRoot,
      sessions: [],
      observedAt,
      onIgnoredPreparationArtifact: (id) => { ignored.push(id); },
    })).resolves.toEqual([]);
    expect(ignored).toEqual([nativeSessionId]);

    const preparedRoot = await fixtureRoot();
    await writeArtifact(preparedRoot, [
      { type: "permission/preset", seq: 0, time: first.time, data: { preset: "workspace-write" } },
      { type: "sandbox/mode", seq: 1, time: first.time + 1, data: { mode: "workspace-write" } },
      { type: "approval/policy", seq: 2, time: first.time + 2, data: { policy: "ask" } },
    ]);
    const preparedIgnored: NativeSessionId[] = [];
    await expect(recoverAlpha2RuntimeTail({
      runId,
      persistenceRoot: preparedRoot,
      sessions: [],
      observedAt,
      onIgnoredPreparationArtifact: (id) => { preparedIgnored.push(id); },
    })).resolves.toEqual([]);
    expect(preparedIgnored).toEqual([nativeSessionId]);

    const nonemptyRoot = await fixtureRoot();
    await writeArtifact(nonemptyRoot, [first]);
    await expect(recover(nonemptyRoot, [])).rejects.toMatchObject({ code: "RECOVERY_MAPPING_MISSING" });
  });

  it("is a no-op only when the committed Alpha2 prefix is exactly unchanged", async () => {
    const root = await fixtureRoot();
    await writeArtifact(root, [first], { compression: "none" });

    await expect(recover(root)).resolves.toEqual([]);
  });

  it("discards an Alpha2 restore prelude unless a real continuation follows it", async () => {
    const root = await fixtureRoot();
    const prelude = [
      { type: "session/end-seed", seq: 1, time: first.time + 1, data: {} },
      { type: "permission/preset", seq: 2, time: first.time + 2, data: { preset: "default" } },
      { type: "sandbox/mode", seq: 3, time: first.time + 3, data: { mode: "workspace-write" } },
      { type: "approval/policy", seq: 4, time: first.time + 4, data: { policy: "on-request" } },
    ];
    await writeArtifact(root, [first, ...prelude]);

    await expect(recover(root)).resolves.toEqual([]);

    const continuedRoot = await fixtureRoot();
    const continuation = {
      type: "user/message",
      seq: 5,
      time: first.time + 5,
      data: { text: "continued in DSH" },
    };
    await writeArtifact(continuedRoot, [first, ...prelude, continuation]);

    const operations = await recover(continuedRoot);
    expect(operations).toHaveLength(1);
    expect((operations[0]!.payload as { events: unknown[] }).events).toEqual([
      ...prelude,
      continuation,
    ]);
    expect(operations[0]!.nativeRevision).toBe(6);
  });

  it("decodes checksummed Zstandard frames and emits one contiguous missing-tail operation", async () => {
    const root = await fixtureRoot();
    const packed = {
      type: "text-chunks",
      seq0: 1,
      time0: first.time + 1,
      data: {
        turn: 0,
        step: 0,
        index: 0,
        dt: [2, 3],
        texts: ["a", "b", "c"],
      },
    };
    await writeArtifact(root, [first, packed]);

    const operations = await recover(root);

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      runId,
      nativeSessionId,
      nativeRevision: 4,
      observedAt,
      payload: {
        logicalSessionId,
        baseVersionId,
        instanceId: "alpha2-synthetic",
      },
    });
    expect((operations[0]!.payload as { events: unknown[] }).events).toEqual([
      {
        type: "assistant/chunk",
        seq: 1,
        time: first.time + 1,
        data: { turn: 0, step: 0, chunk: { type: "text-delta", index: 0, text: "a" } },
      },
      {
        type: "assistant/chunk",
        seq: 2,
        time: first.time + 3,
        data: { turn: 0, step: 0, chunk: { type: "text-delta", index: 0, text: "b" } },
      },
      {
        type: "assistant/chunk",
        seq: 3,
        time: first.time + 6,
        data: { turn: 0, step: 0, chunk: { type: "text-delta", index: 0, text: "c" } },
      },
    ]);
  });

  it("fails closed on a native sequence gap instead of skipping it", async () => {
    const root = await fixtureRoot();
    await writeArtifact(root, [first, { type: "turn/start", seq: 2, time: first.time + 1, data: { turn: 0 } }]);

    await expect(recover(root)).rejects.toMatchObject<Partial<Alpha2RuntimeTailRecoveryError>>({
      code: "RECOVERY_SEQUENCE_GAP",
    });
  });

  it("fails closed when any already committed event was rewritten", async () => {
    const root = await fixtureRoot();
    await writeArtifact(root, [{ ...first, data: { text: "rewritten" } }]);

    await expect(recover(root)).rejects.toMatchObject<Partial<Alpha2RuntimeTailRecoveryError>>({
      code: "RECOVERY_PREFIX_REWRITTEN",
    });
  });

  it("fails closed on an unknown format, header path mismatch, or unmapped artifact", async () => {
    const futureRoot = await fixtureRoot();
    await writeArtifact(futureRoot, [first], { header: { ...header, version: 1 } });
    await expect(recover(futureRoot)).rejects.toMatchObject({ code: "RECOVERY_FORMAT_UNSUPPORTED" });

    const misplacedRoot = await fixtureRoot();
    await writeArtifact(misplacedRoot, [first], { header: { ...header, cwd: "C:/another/project" } });
    await expect(recover(misplacedRoot)).rejects.toMatchObject({ code: "RECOVERY_HEADER_MISMATCH" });

    const unmappedRoot = await fixtureRoot();
    await writeArtifact(unmappedRoot, [first]);
    await expect(recover(unmappedRoot, [])).rejects.toMatchObject({ code: "RECOVERY_MAPPING_MISSING" });
  });
});
