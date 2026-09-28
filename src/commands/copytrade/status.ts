import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { isAlive, readMeta, readPid } from "../../copytrade/daemon.js";
import { sanitizeName } from "../../copytrade/paths.js";

const inputs = {
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Daemon instance name (default 'default')",
    required: false,
    prompt: false,
    index: 0,
  },
} satisfies InputSchema;

type StatusData = {
  name: string;
  running: boolean;
  pid?: number;
  startedAt?: string;
  targets?: string[];
  network?: string;
  sizing?: string;
  dryRun?: boolean;
  logFile?: string;
};

export default class CopytradeStatus extends PluginCommand<StatusData> {
  static override requiresAuth = false;
  static override requiresInit = false;
  static override description = "Show whether a background copytrade daemon is running, and its configuration.";
  static override examples = ["<%= config.bin %> copytrade status", "<%= config.bin %> copytrade status --name mydaemon"];
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "copytrade:status";

  async execute(io: CommandIO): Promise<StatusData> {
    const { name: raw } = await io.resolveInputs(inputs);
    const name = sanitizeName(raw ?? "default");
    const pid = readPid(name);
    const running = pid !== undefined && isAlive(pid);
    const meta = readMeta(name);

    if (!running) {
      io.emit(`copytrade daemon '${name}': not running.`);
      return { name, running: false };
    }

    io.emit(
      `copytrade daemon '${name}': running (pid ${pid})\n` +
        `  started: ${meta?.startedAt ?? "?"}\n` +
        `  targets: ${meta?.targets?.join(", ") ?? "?"}\n` +
        `  network: ${meta?.network ?? "?"} · sizing: ${meta?.sizing ?? "?"}${meta?.dryRun ? " · DRY RUN" : ""}\n` +
        `  logs:    ${meta?.logFile ?? "?"}`
    );

    return {
      name,
      running: true,
      ...(pid !== undefined ? { pid } : {}),
      ...(meta?.startedAt ? { startedAt: meta.startedAt } : {}),
      ...(meta?.targets ? { targets: meta.targets } : {}),
      ...(meta?.network ? { network: meta.network } : {}),
      ...(meta?.sizing ? { sizing: meta.sizing } : {}),
      ...(meta ? { dryRun: meta.dryRun } : {}),
      ...(meta?.logFile ? { logFile: meta.logFile } : {}),
    };
  }
}
