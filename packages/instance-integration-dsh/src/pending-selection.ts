/**
 * The Engine-side record of a folder the operator already checked.
 *
 * Confirming a selection must not trust a path sent back by the browser: the browser would then
 * be able to register any directory as any instance. So the Engine keeps what it inspected, hands
 * out an opaque id, and confirming means "one of the profiles you listed for that id" — the path
 * is re-read from this record, never from the request.
 *
 * Only the checked facts are stored (no bindings, no gate, no Launcher state), so an operator who
 * selects a folder and never confirms leaves nothing behind but this note, which expires.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { instanceHomeProfileSchema } from '@linmu/dsh-session-contracts';
import { IntegrationError, readJsonIfPresent, writeJsonAtomically } from './bindings.js';

export const PENDING_SELECTION_FILE = 'pending-instance-selections.json';
/** A selection is a step in an interactive flow, not durable state: after this it must be re-checked. */
export const PENDING_SELECTION_TTL_MS = 30 * 60 * 1000;

const pendingSelectionSchema = z.strictObject({
  pendingId: z.string().min(1),
  homeRoot: z.string().min(1),
  suggestedInstanceId: z.string().min(1),
  profiles: z.array(instanceHomeProfileSchema).min(1),
  runtimeVersion: z.string().min(1),
  versionRoot: z.string().min(1),
  cliPath: z.string().min(1),
  createdAt: z.iso.datetime(),
});
const fileSchema = z.strictObject({ schemaVersion: z.literal(1), selections: z.array(pendingSelectionSchema) });

export type PendingInstanceSelection = z.infer<typeof pendingSelectionSchema>;

function path(stateRoot: string): string { return join(stateRoot, PENDING_SELECTION_FILE); }

async function readAll(stateRoot: string): Promise<PendingInstanceSelection[]> {
  const value = await readJsonIfPresent(path(stateRoot));
  if (value === undefined) return [];
  const parsed = fileSchema.safeParse(value);
  // An unreadable record is treated as "nothing pending": it is a short-lived note, and refusing
  // every future selection because one is corrupt would block the flow for good.
  return parsed.success ? parsed.data.selections : [];
}

/** Keep one selection, replacing any older record for the same folder. */
export async function savePendingSelection(stateRoot: string, selection: PendingInstanceSelection,
  now: () => string = () => new Date().toISOString()): Promise<void> {
  const current = (await readAll(stateRoot)).filter(item => item.homeRoot !== selection.homeRoot && !expired(item, now()));
  await writeJsonAtomically(path(stateRoot), fileSchema.parse({ schemaVersion: 1, selections: [...current, selection] }));
}

/** The checked folder behind an id, or a refusal that says what to do about it. */
export async function readPendingSelection(stateRoot: string, pendingId: string,
  now: () => string = () => new Date().toISOString()): Promise<PendingInstanceSelection> {
  const found = (await readAll(stateRoot)).find(item => item.pendingId === pendingId);
  if (found === undefined) throw new IntegrationError('INSTANCE_SELECTION_UNKNOWN', '这次文件夹检查已失效，请重新选择实例文件夹。', 404);
  if (expired(found, now())) throw new IntegrationError('INSTANCE_SELECTION_EXPIRED', '文件夹检查已超时，请重新选择实例文件夹以确保内容未变。', 409);
  return found;
}

export async function forgetPendingSelection(stateRoot: string, pendingId: string): Promise<void> {
  const current = (await readAll(stateRoot)).filter(item => item.pendingId !== pendingId);
  await writeJsonAtomically(path(stateRoot), fileSchema.parse({ schemaVersion: 1, selections: current }));
}

function expired(selection: PendingInstanceSelection, now: string): boolean {
  const created = Date.parse(selection.createdAt);
  const current = Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(current)) return true;
  return current - created > PENDING_SELECTION_TTL_MS;
}
