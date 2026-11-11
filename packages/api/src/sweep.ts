import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sweepAttachmentTemps } from "@writers-rolltop/store";

export interface SweepDirs {
  attachmentsDir: string;
  /** Private to the server: export files are built here and served from here. */
  exportsDir: string;
  /** The data folder; leftover `.import-<uuid>.staging` folders are removed. `*.replaced-*` folders are not the server's and are never touched. */
  dataDir?: string;
}

export interface SweepResult { attachmentTemps: number; exports: number; staging: number }

/**
 * Startup sweep. Runs before the server takes requests, so nothing it removes can be in use. Removes
 * temp files a crash left in the attachment store, everything in the exports folder (it only ever holds
 * in-flight export files), and leftover import staging folders.
 */
export async function sweepLeftovers(dirs: SweepDirs): Promise<SweepResult> {
  const result: SweepResult = { attachmentTemps: await sweepAttachmentTemps(dirs.attachmentsDir), exports: 0, staging: 0 };
  for (const name of await readdir(dirs.exportsDir).catch(() => [] as string[])) {
    await rm(join(dirs.exportsDir, name), { recursive: true, force: true }).then(() => { result.exports++; }, () => {});
  }
  if (dirs.dataDir) {
    for (const name of await readdir(dirs.dataDir).catch(() => [] as string[])) {
      if (/^\.import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.staging$/.test(name)) {
        await rm(join(dirs.dataDir, name), { recursive: true, force: true }).then(() => { result.staging++; }, () => {});
      }
    }
  }
  return result;
}
