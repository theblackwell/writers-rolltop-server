import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readArchive } from "../src/index.ts";
import type { ArchiveData } from "../src/index.ts";

/** The vendored Spec fixtures (synced into document-adapter by Server/scripts/sync-spec-fixtures.sh). */
export const specDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "document-adapter", "test", "spec");
export const fixtures = path.join(specDir, "fixtures");
export const archiveFixtures = path.join(fixtures, "archives");
export const readJSON = (...p: string[]): any => JSON.parse(readFileSync(path.join(fixtures, ...p), "utf8"));

export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rolltop-archive-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? d.name : `${prefix}/${d.name}`;
    if (d.isDirectory()) out.push(...await listFilesRecursive(path.join(dir, d.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

export const samplePath = path.join(archiveFixtures, "valid", "sample-library.rolltop");

/** A deep, mutable copy of a fixture archive's data, with attachment bytes. */
export async function loadSample(name = "sample-library"): Promise<{ data: ArchiveData; attachments: Map<string, Buffer> }> {
  const contents = await readArchive(path.join(archiveFixtures, "valid", `${name}.rolltop`));
  try {
    const attachments = new Map<string, Buffer>();
    for (const [sha, f] of contents.attachments) attachments.set(sha, Buffer.from(await f.read()));
    return { data: structuredClone(contents.data), attachments };
  } finally {
    await contents.close();
  }
}

/** All files of a fixture archive (raw bytes by archive path), read from the unpacked fixture folder. */
export async function unpackedFiles(name: string): Promise<Map<string, Buffer>> {
  const root = path.join(archiveFixtures, "valid", name);
  const out = new Map<string, Buffer>();
  for (const rel of await listFilesRecursive(root)) out.set(rel, await readFile(path.join(root, rel)));
  return out;
}

export interface RawEntry {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  flags?: number;
  /** Unix mode in the high 16 bits of the external attributes (default 0o100644). */
  mode?: number;
  madeByHost?: number;
  /** Raw external attributes, overriding `mode`. */
  external?: number;
  /** Lie about the uncompressed size in the central directory. */
  declaredSize?: number;
  declaredCrc?: number;
  /** Name stored in the local header, if different. */
  localName?: string;
  /** Override the local-header offset in the central directory. */
  centralOffset?: number;
  /** An extra field in the LOCAL header only (the central directory does not mention it). */
  localExtra?: Buffer;
}

/** A deliberately low-level ZIP builder so tests can write hostile archives. */
export function buildZip(entries: RawEntry[], extra: { eocdCount?: number; comment?: string; zip64Count?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data) : e.data;
    const nameBytes = Buffer.from(e.name, "utf8");
    const localNameBytes = Buffer.from(e.localName ?? e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(localNameBytes.length, 26);
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    local.writeUInt16LE(localExtra.length, 28);
    const localOffset = offset;
    parts.push(local, localNameBytes, localExtra, body);
    offset += 30 + localNameBytes.length + localExtra.length + body.length;
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(((e.madeByHost ?? 3) << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.flags ?? 0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(e.declaredCrc ?? crc32(e.data), 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.declaredSize ?? e.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(e.external ?? (((e.mode ?? 0o100644) << 16) >>> 0), 38);
    cd.writeUInt32LE(e.centralOffset ?? localOffset, 42);
    central.push(cd, nameBytes);
  }
  const cdBytes = Buffer.concat(central);
  const comment = Buffer.from(extra.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = extra.zip64Count ? 0xffff : (extra.eocdCount ?? entries.length);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cdBytes, end, comment]);
}

/** Rebuilds checksums.json and the manifest pin after files were edited, then zips everything. */
export function archiveFromFiles(files: Map<string, Buffer>, tweak: (entries: RawEntry[]) => RawEntry[] = (e) => e): Buffer {
  const f = new Map(files);
  const listed = [...f.keys()].filter((p) => p !== "manifest.json" && p !== "checksums.json").sort();
  const checksums = Buffer.from(JSON.stringify({ algorithm: "sha256", files: listed.map((p) => ({ path: p, byteLength: f.get(p)!.length, sha256: sha256(f.get(p)!) })) }));
  f.set("checksums.json", checksums);
  const manifest = JSON.parse(f.get("manifest.json")!.toString("utf8"));
  manifest.checksums = { path: "checksums.json", byteLength: checksums.length, sha256: sha256(checksums) };
  f.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
  const order = ["manifest.json", "checksums.json", ...listed];
  return buildZip(tweak(order.map((name) => ({ name, data: f.get(name)! }))));
}
