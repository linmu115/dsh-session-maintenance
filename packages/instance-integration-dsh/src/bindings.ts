import { readFile } from "node:fs/promises";
export { IntegrationError } from "@linmu/dsh-session-contracts";
export async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
