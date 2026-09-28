import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { resolveMmBin } from "./mmBin.js";
import { daemonPaths } from "./paths.js";

export type DaemonMeta = {
  name: string;
  pid: number;
  startedAt: string;
  targets: string[];
  network: string;
  sizing: string;
  dryRun: boolean;
  logFile: string;
};

/**
 * Fork a detached background worker running `copytrade start … --foreground`.
 *
 * The child is reparented to init (`detached: true` + `unref`) and writes stdout
 * and stderr to the instance log file, so it survives the launching terminal or
 * Claude Code session closing. We persist its PID and a metadata summary for the
 * `stop` / `status` / `logs` commands.
 */
export function spawnDaemon(params: {
  name: string;
  childArgs: string[];
  meta: Omit<DaemonMeta, "pid" | "startedAt" | "logFile">;
}): DaemonMeta {
  const paths = daemonPaths(params.name);

  const existing = readPid(params.name);
  if (existing !== undefined && isAlive(existing)) {
    throw new Error(`A copytrade daemon named '${params.name}' is already running (pid ${existing}). Stop it first: mm copytrade stop --name ${params.name}`);
  }

  const { cmd, pre } = resolveMmBin();
  const logFd = openSync(paths.log, "a");
  const child = spawn(cmd, [...pre, ...params.childArgs], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  if (child.pid === undefined) {
    throw new Error("Failed to spawn copytrade daemon (no pid).");
  }

  const meta: DaemonMeta = {
    ...params.meta,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logFile: paths.log,
  };
  writeFileSync(paths.pid, String(child.pid), "utf8");
  writeFileSync(paths.meta, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

export function readPid(name: string): number | undefined {
  const { pid } = daemonPaths(name);
  if (!existsSync(pid)) return undefined;
  const raw = readFileSync(pid, "utf8").trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function readMeta(name: string): DaemonMeta | undefined {
  const { meta } = daemonPaths(name);
  if (!existsSync(meta)) return undefined;
  try {
    return JSON.parse(readFileSync(meta, "utf8")) as DaemonMeta;
  } catch {
    return undefined;
  }
}

/** True if a process with this pid currently exists (signal 0 probe). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still "alive").
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type StopResult = "stopped" | "not-running" | "kill-failed";

/** Send SIGTERM to the daemon and clean up its PID file. */
export function stopDaemon(name: string): { result: StopResult; pid?: number } {
  const pid = readPid(name);
  if (pid === undefined || !isAlive(pid)) {
    clearPidFile(name);
    return { result: "not-running" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { result: "kill-failed", pid };
  }
  clearPidFile(name);
  return { result: "stopped", pid };
}

export function clearPidFile(name: string): void {
  const { pid } = daemonPaths(name);
  try {
    rmSync(pid, { force: true });
  } catch {
    // ignore
  }
}
