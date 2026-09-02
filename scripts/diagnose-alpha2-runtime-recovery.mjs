import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  recoverAlpha2ProjectionSession,
  recoverAlpha2RuntimeTail,
  recoverUnmappedAlpha2ProjectionSession,
} from "../packages/adapter-dsh-alpha2/dist/index.js";

const [databaseValue, runId, projectionRootValue] = process.argv.slice(2);
if (!databaseValue || !runId || !projectionRootValue) {
  throw new TypeError(
    "usage: diagnose-alpha2-runtime-recovery.mjs <metadata.sqlite> <run-id> <projection-root>",
  );
}

const databasePath = resolve(databaseValue);
const projectionRoot = resolve(projectionRootValue);
const runtimeRoot = join(projectionRoot, "runtime-sessions");
const sessionRoot = join(projectionRoot, "sessions");
const database = new DatabaseSync(databasePath, { readOnly: true });

function payloadPath(nativeSessionId) {
  return join(sessionRoot, `${Buffer.from(nativeSessionId, "utf8").toString("base64url")}.json`);
}

async function artifactSessionIds(root) {
  const ids = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const session of await readdir(join(root, project.name), { withFileTypes: true })) {
      if (session.isDirectory()) ids.push(session.name);
    }
  }
  return ids.sort();
}

function errorChain(error) {
  const chain = [];
  for (let current = error; current !== undefined && current !== null; current = current.cause) {
    chain.push({
      name: current instanceof Error ? current.name : typeof current,
      code: typeof current === "object" && "code" in current ? current.code : null,
      message: current instanceof Error ? current.message : String(current),
    });
  }
  return chain;
}

try {
  const ids = await artifactSessionIds(runtimeRoot);
  const lookup = database.prepare(
    `SELECT run_id, native_session_id, logical_session_id, base_version_id, mode,
            native_revision, last_committed_operation_id, derived_child_session_id
       FROM projection_sessions
      WHERE run_id = ? AND native_session_id = ?`,
  );
  const mappings = [];
  const missing = [];
  let projectedBytes = 0;
  for (const nativeSessionId of ids) {
    const row = lookup.get(runId, nativeSessionId);
    if (row === undefined) {
      const raw = await readFile(payloadPath(nativeSessionId), "utf8").catch(() => null);
      if (raw === null) {
        missing.push(nativeSessionId);
        continue;
      }
      projectedBytes += Buffer.byteLength(raw);
      const recovered = recoverUnmappedAlpha2ProjectionSession(
        runId,
        nativeSessionId,
        JSON.parse(raw),
      );
      mappings.push({
        nativeSessionId,
        logicalSessionId: recovered.logicalSessionId,
        baseVersionId: recovered.baseVersionId,
        nativeRevision: recovered.nativeRevision,
        header: recovered.recovered.header,
        committedEvents: recovered.recovered.committedEvents,
      });
      continue;
    }
    const raw = await readFile(payloadPath(nativeSessionId), "utf8");
    projectedBytes += Buffer.byteLength(raw);
    const payload = JSON.parse(raw);
    const projection = {
      schemaVersion: 1,
      runId: row.run_id,
      nativeSessionId: row.native_session_id,
      logicalSessionId: row.logical_session_id,
      baseVersionId: row.base_version_id,
      mode: row.mode,
      nativeRevision: row.native_revision,
      lastCommittedOperationId: row.last_committed_operation_id,
      derivedChildSessionId: row.derived_child_session_id,
    };
    const recovered = recoverAlpha2ProjectionSession(projection, payload);
    mappings.push({
      nativeSessionId: projection.nativeSessionId,
      logicalSessionId: projection.logicalSessionId,
      baseVersionId: projection.baseVersionId,
      nativeRevision: projection.nativeRevision,
      header: recovered.header,
      committedEvents: recovered.committedEvents,
    });
  }
  if (missing.length > 0) {
    console.log(JSON.stringify({ ok: false, stage: "mapping", artifacts: ids.length, missing }, null, 2));
    process.exitCode = 1;
  } else {
    const operations = await recoverAlpha2RuntimeTail({
      runId,
      persistenceRoot: runtimeRoot,
      sessions: mappings,
      observedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({
      ok: true,
      stage: "runtime-tail",
      artifacts: ids.length,
      mappings: mappings.length,
      projectedBytes,
      operations: operations.map((operation) => ({
        nativeSessionId: operation.nativeSessionId,
        nativeRevision: operation.nativeRevision,
        tailEvents: Array.isArray(operation.payload?.events) ? operation.payload.events.length : null,
        tailTypes: Array.isArray(operation.payload?.events)
          ? operation.payload.events.map((event) => event?.type ?? null)
          : null,
      })),
    }, null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    stage: "runtime-tail",
    error: errorChain(error),
  }, null, 2));
  process.exitCode = 1;
} finally {
  database.close();
}
