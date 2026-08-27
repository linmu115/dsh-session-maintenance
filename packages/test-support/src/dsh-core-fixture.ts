import { createHash } from "node:crypto";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const DEFAULT_CONTRACT = {
  platformVersion: "0.1.1-rc.2",
  sessionFormatVersion: 0,
  workspaceDomainVersion: 2,
  projectionDomainVersion: 3,
  querySchemaVersion: 8,
  packages: {
    "@deepseek-ai/dsh-session-persistence": {
      version: "0.1.1-rc.2",
      integrity:
        "sha512-dxdYxRfmK5jWtiFFabqRNb/jGGjkXyF2djI7O8IIKmDVjhQiv170zpvhbAhRUuqClEdseCtbQpLBrRm2blzt3g==",
    },
    "@deepseek-ai/dsh-workspace": {
      version: "0.1.1-rc.2",
      integrity:
        "sha512-jBUob4H5TZAiExq9YNVCglKAFmAKMtd1UbyqFfnZZ1Owm+3c3NbAXY947MHiD6NwCwFEW1y7FjrFj66UQvG90A==",
    },
  },
  implementationHashes: {
    session: "sha256:c0bb646e5dc33ab770fc14531bc60ce6660a4ac07b47c0c180c909f51e9ffc8d",
    sessionPersistence: "sha256:d08210e95ae22c7cb22a6208f0ebc02d38898f01aabf4f82924ee2bffcbc2cad",
    jsonlPersistence: "sha256:8b6ebc4509a3e969ab3ad6e0dfb553ae4861e5b101831afed23e593d148d97f3",
    workspace: "sha256:d53e71d931937066ff20440afcff911ced09cefb8a0f3d024348b0e5248d4c74",
    projectionCache: "sha256:4610b2c2405b0e059caf651a9c35babcee3badedb7225d4d242a7388b2f9b1d1",
    querySqlite: "sha256:d35c13881eeb9d393fa3a21acaafa6277692e77f90e579ea62a95d6ea0cf370a",
  },
  methods: {
    sessionPersistence: ["append", "create", "inspect", "list", "locate"],
    persistenceCoordinator: ["preparations.invalidate", "serialize", "states"],
    workspaceRegistry: [
      "archiveSession",
      "enqueueOperation",
      "get",
      "list",
      "replaceHeaderIndex",
      "setState",
    ],
    workspaceEntity: ["attachSession", "detachSession", "insertSessionBefore"],
    projectionTable: ["delete", "get", "put"],
    sessionQuery: ["_ensureReady", "_reconcile", "_serialized"],
  },
} as const;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

interface FixtureEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Json;
  readonly surfaceOp?: Json;
}

interface FixtureSession {
  readonly header: {
    readonly version: 0;
    readonly id: string;
    readonly createdAt: number;
    readonly cwd: string;
    readonly delegationDepth: 0;
  };
  readonly events: readonly FixtureEvent[];
  readonly revision: number;
}

type FixtureContract = {
  readonly platformVersion: string;
  readonly sessionFormatVersion: number;
  readonly workspaceDomainVersion: number;
  readonly projectionDomainVersion: number;
  readonly querySchemaVersion: number;
  readonly packages: Readonly<Record<keyof typeof DEFAULT_CONTRACT.packages, {
    readonly version: string;
    readonly integrity: string;
  }>>;
  readonly implementationHashes: Readonly<Record<keyof typeof DEFAULT_CONTRACT.implementationHashes, string>>;
  readonly methods: {
    readonly sessionPersistence: readonly string[];
    readonly persistenceCoordinator: readonly string[];
    readonly workspaceRegistry: readonly string[];
    readonly workspaceEntity: readonly string[];
    readonly projectionTable: readonly string[];
    readonly sessionQuery: readonly string[];
  };
};

export interface DshCoreFixtureOptions {
  readonly contract?: FixtureContract;
}

export function createDshCoreFixtureHost(options: DshCoreFixtureOptions = {}) {
  const sessions = new Map<string, FixtureSession>([
    [
      "dsh-session-1",
      {
        header: {
          version: 0,
          id: "dsh-session-1",
          createdAt: 1,
          cwd: "C:\\fixture\\workspace",
          delegationDepth: 0,
        },
        events: [
          { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "hello" }] } },
          { type: "assistant/message", seq: 1, time: 2, data: { content: [{ type: "text", text: "response" }] } },
          { type: "tool/call", seq: 2, time: 3, data: { name: "fixture" } },
          { type: "tool/result", seq: 3, time: 4, data: { name: "fixture" } },
        ],
        revision: 1,
      },
    ],
  ]);
  const workspace = {
    id: "workspace-fixture",
    members: ["dsh-session-1"],
    archived: [] as string[],
  };
  const projections = new Map<string, Json>([
    ["dsh-session-1", { title: "Fixture conversation", asOfSeq: 3 }],
  ]);
  const query = new Map<string, string>([["dsh-session-1", digest(sessions.get("dsh-session-1"))]]);
  const coordinator = new Map<string, string>();
  let fault: string | undefined;

  const host = {
    writes: [] as string[],
    observeContract: async () => clone(options.contract ?? DEFAULT_CONTRACT),
    isSessionLive: (_sessionId: string) => false,
    captureSession: async (sessionId: string) => {
      const session = sessions.get(sessionId);
      return session === undefined
        ? { exists: false as const }
        : { exists: true as const, header: clone(session.header), events: clone(session.events), revision: String(session.revision), artifact: Buffer.from(JSON.stringify(session)).toString("base64") };
    },
    captureWorkspace: async (sessionId: string, workspaceId?: string) => {
      const index = workspace.members.indexOf(sessionId);
      return {
        workspaceId: workspaceId ?? workspace.id,
        memberIndex: index < 0 ? null : index,
        beforeSessionId: index < 0 ? null : workspace.members[index + 1] ?? null,
        archived: workspace.archived.includes(sessionId),
      };
    },
    captureProjection: async (sessionId: string) => {
      const record = projections.get(sessionId);
      return record === undefined
        ? { present: false as const }
        : { present: true as const, record: clone(record) };
    },
    captureRuntime: async (sessionId: string) => ({
      coordinator: coordinator.get(sessionId) ?? "cold",
      queryIndex: query.get(sessionId) ?? "absent",
    }),
    createSession: async (header: FixtureSession["header"]) => {
      host.writes.push("create-session");
      sessions.set(header.id, { header: clone(header), events: [], revision: 0 });
      coordinator.set(header.id, "prepared");
      if (fault === "after-session-mutation") throw new Error(`fixture fault: ${fault}`);
    },
    appendEvents: async (sessionId: string, events: readonly FixtureEvent[]) => {
      host.writes.push("append-events");
      const current = sessions.get(sessionId);
      if (current === undefined) throw new Error(`missing fixture session: ${sessionId}`);
      sessions.set(sessionId, {
        ...current,
        events: [...current.events, ...clone(events)],
        revision: current.revision + 1,
      });
      coordinator.set(sessionId, "dirty");
      if (fault === "after-session-mutation") throw new Error(`fixture fault: ${fault}`);
    },
    attachWorkspace: async (sessionId: string, workspaceId: string) => {
      host.writes.push("attach-workspace");
      if (workspaceId !== workspace.id) throw new Error(`unknown fixture workspace: ${workspaceId}`);
      if (!workspace.members.includes(sessionId)) workspace.members.unshift(sessionId);
      if (fault === "after-workspace-mutation") throw new Error(`fixture fault: ${fault}`);
    },
    setArchive: async (sessionId: string, archived: boolean) => {
      host.writes.push("set-archive");
      workspace.archived = archived
        ? [...new Set([...workspace.archived, sessionId])]
        : workspace.archived.filter((id) => id !== sessionId);
    },
    invalidateProjection: async (sessionId: string) => {
      host.writes.push("invalidate-projection");
      projections.delete(sessionId);
    },
    reconcileRuntime: async (sessionId: string) => {
      host.writes.push("reconcile-runtime");
      coordinator.delete(sessionId);
      const session = sessions.get(sessionId);
      if (session === undefined) query.delete(sessionId);
      else query.set(sessionId, digest(session));
    },
    restoreSession: async (snapshot: { readonly exists: boolean; readonly artifact?: string }) => {
      host.writes.push("restore-session");
      const parsed = snapshot.exists && snapshot.artifact !== undefined
        ? JSON.parse(Buffer.from(snapshot.artifact, "base64").toString("utf8")) as FixtureSession
        : undefined;
      const id = parsed?.header.id ?? "dsh-session-1";
      if (parsed === undefined) sessions.delete(id);
      else sessions.set(id, clone(parsed));
      coordinator.delete(id);
    },
    restoreWorkspace: async (sessionId: string, snapshot: { readonly memberIndex: number | null; readonly archived: boolean }) => {
      host.writes.push("restore-workspace");
      workspace.members = workspace.members.filter((id) => id !== sessionId);
      if (snapshot.memberIndex !== null) workspace.members.splice(snapshot.memberIndex, 0, sessionId);
      workspace.archived = snapshot.archived
        ? [...new Set([...workspace.archived, sessionId])]
        : workspace.archived.filter((id) => id !== sessionId);
    },
    restoreProjection: async (sessionId: string, snapshot: { readonly present: boolean; readonly record?: Json }) => {
      host.writes.push("restore-projection");
      if (snapshot.present && snapshot.record !== undefined) projections.set(sessionId, clone(snapshot.record));
      else projections.delete(sessionId);
    },
    setFault(value: string | undefined) {
      fault = value;
    },
    domainDigests(sessionId: string) {
      return {
        session: digest(sessions.get(sessionId) ?? null),
        workspace: digest(workspace),
        projection: digest(projections.get(sessionId) ?? null),
        coordinator: digest(coordinator.get(sessionId) ?? "cold"),
        query: digest(query.get(sessionId) ?? "absent"),
      };
    },
  };
  return host;
}
