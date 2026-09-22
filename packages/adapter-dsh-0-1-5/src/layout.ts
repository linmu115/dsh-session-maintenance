import { resolve } from "node:path";
import type { Obj } from "./common.js";
function fail(_code:string,message:string):never{throw new TypeError(message);}
function encodeSegment(raw: string): string {
  if (raw.length === 0) fail("RECOVERY_HEADER_MISMATCH", "Rc1 session ID cannot be empty");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== "~" && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

export function projectKey(cwd: string): string {
  if (cwd.length === 0) fail("RECOVERY_HEADER_MISMATCH", "Rc1 SessionHeader.cwd cannot be empty");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

export function expectedV3ArtifactPath(root: string, header: Obj, compression: "none" | "zstd"): string {
  const cwd = header.cwd;
  const project = cwd === undefined ? "_no-cwd" : typeof cwd === "string" ? projectKey(cwd) : fail(
    "RECOVERY_HEADER_MISMATCH",
    "Rc1 SessionHeader.cwd must be a string when present",
  );
  const id = header.id;
  if (typeof id !== "string") fail("RECOVERY_HEADER_MISMATCH", "Rc1 SessionHeader.id must be a string");
  return resolve(root, project, encodeSegment(id), compression === "zstd" ? "session.v3.jsonl.zstd" : "session.v3.jsonl");
}
