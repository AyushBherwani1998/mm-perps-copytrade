import { spawn } from "node:child_process";

import { resolveMmBin } from "./mmBin.js";
import type { PerpsNetwork, PerpsSide } from "./types.js";

export type OrderOutcome = {
  ok: boolean;
  orderId?: string;
  status?: string;
  raw?: unknown;
  error?: string;
};

export type ExecutorOptions = {
  venue: string;
  network: PerpsNetwork;
  maxSlippageBps?: number;
  dryRun: boolean;
  /** Per-order subprocess timeout. */
  timeoutMs?: number;
  /** Logger for the raw command line (verbose/debug). */
  onSpawn?: (argv: string[]) => void;
};

/**
 * Submits mirrored orders by invoking the host `mm perps` command in a child
 * process.
 *
 * We shell out rather than call `config.runCommand` in-process because the host
 * command's `run()` ends with `process.exit()`, which would tear down our
 * long-running watcher after the first order. A subprocess reuses the host's
 * signing/auth/policy path (server-wallet mode needs no prompt) while keeping
 * this loop alive. `--dry-run` adds the host flag so nothing is signed.
 */
export class PerpsExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  async open(params: { symbol: string; side: PerpsSide; size: string; leverage: number }): Promise<OrderOutcome> {
    const argv = [
      "perps",
      "open",
      "--venue",
      this.opts.venue,
      "--network",
      this.opts.network,
      "--symbol",
      params.symbol,
      "--side",
      params.side,
      "--size",
      params.size,
      "--leverage",
      String(params.leverage),
      ...this.slippageArgs(),
      ...this.tailArgs(),
    ];
    return this.run(argv);
  }

  async close(params: { symbol: string; size?: string }): Promise<OrderOutcome> {
    const argv = [
      "perps",
      "close",
      "--venue",
      this.opts.venue,
      "--network",
      this.opts.network,
      "--symbol",
      params.symbol,
      ...(params.size ? ["--size", params.size] : []),
      ...this.slippageArgs(),
      ...this.tailArgs(),
    ];
    return this.run(argv);
  }

  private slippageArgs(): string[] {
    return this.opts.maxSlippageBps !== undefined ? ["--max-slippage-bps", String(this.opts.maxSlippageBps)] : [];
  }

  private tailArgs(): string[] {
    return [...(this.opts.dryRun ? ["--dry-run"] : []), "--yes", "--json"];
  }

  private async run(argv: string[]): Promise<OrderOutcome> {
    const { cmd, pre } = resolveMmBin();
    const fullArgs = [...pre, ...argv];
    this.opts.onSpawn?.([cmd, ...fullArgs]);

    return new Promise<OrderOutcome>((resolve) => {
      const child = spawn(cmd, fullArgs, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ ok: false, error: `order timed out after ${this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
      }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // The host prints pretty-printed JSON, and routes errors to stderr, so
        // look in both streams and parse across line breaks.
        const parsed = parseJsonBlock(stdout) ?? parseJsonBlock(stderr);
        const payload = unwrapData(parsed);
        const orderId = pickString(payload, "orderId");
        const status = pickString(payload, "status");
        if (code === 0) {
          resolve({ ok: true, ...(orderId ? { orderId } : {}), ...(status ? { status } : {}), raw: parsed ?? stdout });
        } else {
          const error = extractError(parsed, stderr, code);
          resolve({ ok: false, error, raw: parsed ?? stdout ?? stderr });
        }
      });
    });
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Extract the last JSON object from a stream, spanning line breaks.
 *
 * The host pretty-prints its `--json` payload, so the object covers many lines
 * and a per-line parse only ever sees a bare `{`. We scan backwards for a
 * balanced brace block (ignoring braces inside strings) and parse that.
 */
export function parseJsonBlock(out: string): Record<string, unknown> | undefined {
  for (let end = out.lastIndexOf("}"); end !== -1; end = out.lastIndexOf("}", end - 1)) {
    const start = matchingBraceStart(out, end);
    if (start === undefined) continue;
    try {
      const obj = JSON.parse(out.slice(start, end + 1)) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj) && !("_notice" in (obj as Record<string, unknown>))) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // keep scanning earlier blocks
    }
  }
  return undefined;
}

/** Index of the `{` that opens the block closing at `end`, or undefined. */
function matchingBraceStart(s: string, end: number): number | undefined {
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = s[i];
    if (inString) {
      if (ch === '"' && !isEscaped(s, i)) inString = false;
      continue;
    }
    if (ch === '"' && !isEscaped(s, i)) {
      inString = true;
    } else if (ch === "}") {
      depth += 1;
    } else if (ch === "{") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function isEscaped(s: string, i: number): boolean {
  let backslashes = 0;
  for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes += 1;
  return backslashes % 2 === 1;
}

/** Host payloads wrap the result in `{ ok, data }`; read through to `data`. */
function unwrapData(parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const data = parsed?.data;
  if (Array.isArray(data)) {
    const first = data[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : parsed;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : parsed;
}

/**
 * Best available reason a command failed: the host's structured
 * `error.code`/`error.message`, else a meaningful stderr line, else the exit
 * code. Brace-only lines and Node's deprecation noise are skipped so the
 * surfaced reason is never a bare `{`.
 */
export function extractError(parsed: Record<string, unknown> | undefined, stderr: string, code: number | null): string {
  const err = parsed?.error;
  if (err && typeof err === "object") {
    const errObj = err as Record<string, unknown>;
    const message = pickString(errObj, "message");
    if (message) {
      const errCode = pickString(errObj, "code");
      return errCode ? `${errCode}: ${message}` : message;
    }
  }
  return pickString(parsed, "message") ?? meaningfulLine(stderr) ?? `exit code ${code ?? "null"}`;
}

function pickString(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

function meaningfulLine(s: string): string | undefined {
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 1 && !/^[{}[\],]+$/.test(l) && !l.includes("DeprecationWarning") && !l.startsWith("(Use `node"));
  return line || undefined;
}
