import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { SessionMaintenanceError } from "@linmu/dsh-session-contracts";

export const FIXTURE_MARKER = ".dsh-session-maintenance-fixture";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface FixtureSandbox {
  readonly root: string;
  readonly codexHome: string;
  readonly dshHome: string;
  readonly cleanup: () => Promise<void>;
}

function forbidden(message: string, cause?: unknown): never {
  throw new SessionMaintenanceError(
    "LIVE_HOME_FORBIDDEN",
    `LIVE_HOME_FORBIDDEN: ${message}`,
    cause === undefined ? {} : { cause },
  );
}

function isContained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function assertFixtureSandbox(root: string): void {
  let resolvedRoot: string;
  let resolvedTemp: string;
  try {
    resolvedRoot = realpathSync(resolve(root));
    resolvedTemp = realpathSync(resolve(tmpdir()));
  } catch (error) {
    forbidden(`fixture root cannot be resolved: ${root}`, error);
  }

  if (resolvedRoot === resolvedTemp || !isContained(resolvedTemp, resolvedRoot)) {
    forbidden(`fixture root is outside the marked temporary boundary: ${resolvedRoot}`);
  }

  let current = resolvedRoot;
  while (isContained(resolvedTemp, current) && current !== resolvedTemp) {
    const marker = join(current, FIXTURE_MARKER);
    try {
      const info = lstatSync(marker);
      if (info.isSymbolicLink() || !info.isFile()) {
        forbidden(`fixture marker is not a regular file: ${marker}`);
      }
      const markerId = readFileSync(marker, "utf8").trim();
      if (!UUID_PATTERN.test(markerId)) {
        forbidden(`fixture marker is invalid: ${marker}`);
      }
      return;
    } catch (error) {
      if (error instanceof SessionMaintenanceError) {
        throw error;
      }
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") {
        forbidden(`fixture marker cannot be inspected: ${marker}`, error);
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  forbidden(`no valid fixture marker protects: ${resolvedRoot}`);
}

export async function createFixtureSandbox(name: string): Promise<FixtureSandbox> {
  const safeName = name.replaceAll(/[^A-Za-z0-9_-]/gu, "-").slice(0, 40) || "fixture";
  const root = await mkdtemp(join(tmpdir(), `dsh-session-maintenance-${safeName}-`));
  const codexHome = join(root, "codex-home");
  const dshHome = join(root, "dsh-home");
  await writeFile(join(root, FIXTURE_MARKER), `${randomUUID()}\n`, { flag: "wx" });
  await mkdir(codexHome);
  await mkdir(dshHome);

  return {
    root,
    codexHome,
    dshHome,
    cleanup: async () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}
