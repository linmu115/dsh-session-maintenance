import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const state = join(process.env.LOCALAPPDATA, 'DSH-Session-Maintenance');
const text = await readFile(join(state, 'config.yaml'), 'utf8');
// This installation field is deliberately restricted to one local SQLite filename.
const filename = /^databaseFile:\s*["']?(metadata[a-z0-9.-]*\.sqlite)["']?\s*$/m.exec(text)?.[1];
assert.ok(filename, 'Unknown database selection; no stop requested');
const db = new DatabaseSync(join(state, filename), { readOnly: true });
const activeRuns = db.prepare("SELECT count(*) n FROM projection_runs WHERE state NOT IN ('closed','recovered','quarantined')").get().n;
const activeJobs = db.prepare("SELECT count(*) n FROM jobs WHERE status IN ('queued','running')").get().n;
db.close(); assert.equal(activeRuns, 0, 'Managed instances must complete normal close first'); assert.equal(activeJobs, 0, 'Wait for active jobs');
const connection = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8'));
assert.equal(connection.host, '127.0.0.1'); console.log(JSON.stringify({ pid: connection.pid, activeRuns, activeJobs }));
