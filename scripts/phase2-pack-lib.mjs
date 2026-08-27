import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function octal(buffer, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0");
  buffer.write(encoded.slice(-(length - 1)), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function header(name, size, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar path exceeds 100 bytes: ${name}`);
  const value = Buffer.alloc(512);
  value.write(name, 0, 100, "utf8");
  octal(value, 100, 8, mode);
  octal(value, 108, 8, 0);
  octal(value, 116, 8, 0);
  octal(value, 124, 12, size);
  octal(value, 136, 12, 0);
  value.fill(0x20, 148, 156);
  value[156] = "0".charCodeAt(0);
  value.write("ustar\0", 257, 6, "ascii");
  value.write("00", 263, 2, "ascii");
  value.write("root", 265, 4, "ascii");
  value.write("root", 297, 4, "ascii");
  const checksum = value.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0").slice(-6);
  value.write(checksumText, 148, 6, "ascii");
  value[154] = 0;
  value[155] = 0x20;
  return value;
}

async function filesUnder(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported artifact entry: ${path}`);
    }
  };
  await visit(root);
  return files;
}

function canonicalArtifactBytes(name, bytes) {
  if (!/(?:^|\/)(?:README\.md|LICENSE)$/u.test(name) && !/\.(?:css|d\.ts|html|js|json|md|mjs|ts|tsx|yml|yaml)$/u.test(name)) {
    return bytes;
  }
  return Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
}

export async function deterministicTarGz(root, prefix) {
  const chunks = [];
  for (const path of await filesUnder(root)) {
    const name = `${prefix}/${relative(root, path).replaceAll("\\", "/")}`;
    const bytes = canonicalArtifactBytes(name, await readFile(path));
    chunks.push(header(name, bytes.byteLength, name.endsWith(".cmd") ? 0o755 : 0o644), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

export function readTarGz(bytes) {
  const tar = gunzipSync(bytes);
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= tar.byteLength) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const sizeText = block.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar size for ${name}`);
    const start = offset + 512;
    const end = start + size;
    if (end > tar.byteLength || entries.has(name)) throw new Error(`Invalid or duplicate tar entry: ${name}`);
    entries.set(name, Buffer.from(tar.subarray(start, end)));
    offset = end + ((512 - (size % 512)) % 512);
  }
  return entries;
}
