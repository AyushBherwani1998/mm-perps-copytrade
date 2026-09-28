import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";

import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { daemonPaths, sanitizeName } from "../../copytrade/paths.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Daemon instance name (default 'default')",
    required: false,
    prompt: false,
    index: 0,
  },
  lines: {
    type: InputFieldType.Text,
    flag: "lines",
    message: "Number of trailing lines to show (default 50)",
    required: false,
    prompt: false,
  },
  follow: {
    type: InputFieldType.Boolean,
    flag: "follow",
    aliases: ["f"],
    message: "Stream new log lines until interrupted (Ctrl-C)",
    required: false,
    prompt: false,
    default: false,
  },
} satisfies InputSchema;

type LogsData = { name: string; logFile: string; shown: number; followed: boolean };

export default class CopytradeLogs extends PluginCommand<LogsData> {
  static override requiresAuth = false;
  static override requiresInit = false;
  static override description = "Show (and optionally follow) the log output of a background copytrade daemon.";
  static override examples = [
    "<%= config.bin %> copytrade logs",
    "<%= config.bin %> copytrade logs --lines 200",
    "<%= config.bin %> copytrade logs --follow",
  ];
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "copytrade:logs";

  async execute(io: CommandIO): Promise<LogsData> {
    const { name: raw, lines: linesRaw, follow } = await io.resolveInputs(inputs);
    const name = sanitizeName(raw ?? "default");
    const { log: logFile } = daemonPaths(name);
    const lineCount = clampInt(linesRaw, 50);

    if (!existsSync(logFile)) {
      io.emit(`No log file for copytrade daemon '${name}' (${logFile}).`);
      return { name, logFile, shown: 0, followed: false };
    }

    const content = readFileSync(logFile, "utf8");
    const all = content.split("\n");
    const tail = all.slice(Math.max(0, all.length - lineCount - 1));
    for (const line of tail) if (line) io.emit(line);

    if (follow !== true) {
      return { name, logFile, shown: tail.filter(Boolean).length, followed: false };
    }

    await this.follow(io, logFile);
    return { name, logFile, shown: tail.filter(Boolean).length, followed: true };
  }

  /** Poll the log for appended bytes and emit them until the run is cancelled. */
  private async follow(io: CommandIO, logFile: string): Promise<void> {
    let offset = statSync(logFile).size;
    io.progress("Following logs (Ctrl-C to stop)...");
    while (!io.signal.aborted) {
      await delay(500, io.signal);
      let size: number;
      try {
        size = statSync(logFile).size;
      } catch {
        continue;
      }
      if (size <= offset) continue;
      const fh = await open(logFile, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        await fh.read(buf, 0, buf.length, offset);
        offset = size;
        for (const line of buf.toString("utf8").split("\n")) if (line) io.emit(line);
      } finally {
        await fh.close();
      }
    }
    io.progress();
  }
}

function clampInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
