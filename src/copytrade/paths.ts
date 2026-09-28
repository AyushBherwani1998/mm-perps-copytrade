import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A validated daemon instance name (used in file names). */
export function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  return cleaned || "default";
}

/** Base directory for copytrade daemon state, under the MetaMask config home. */
export function baseDir(): string {
  const dir = join(homedir(), ".metamask", "copytrade");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type DaemonPaths = { pid: string; log: string; meta: string };

export function daemonPaths(name: string): DaemonPaths {
  const base = baseDir();
  const safe = sanitizeName(name);
  return {
    pid: join(base, `${safe}.pid`),
    log: join(base, `${safe}.log`),
    meta: join(base, `${safe}.json`),
  };
}
