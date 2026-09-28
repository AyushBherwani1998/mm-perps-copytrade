import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToFlags } from "@metamask/agent-wallet/plugin";

import { clearPidFile, stopDaemon } from "../../copytrade/daemon.js";
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

type StopData = { name: string; result: string; pid?: number };

export default class CopytradeStop extends PluginCommand<StopData> {
  static override requiresAuth = false;
  static override requiresInit = false;
  static override description = "Stop a background copytrade daemon started with `copytrade start --daemon`.";
  static override examples = ["<%= config.bin %> copytrade stop", "<%= config.bin %> copytrade stop --name mydaemon"];
  static override flags = schemaToFlags(inputs);

  protected readonly pluginCommandId = "copytrade:stop";

  async execute(io: CommandIO): Promise<StopData> {
    const { name: raw } = await io.resolveInputs(inputs);
    const name = sanitizeName(raw ?? "default");
    const { result, pid } = stopDaemon(name);
    if (result === "stopped") {
      clearPidFile(name);
      io.emit(`Stopped copytrade daemon '${name}' (pid ${pid}).`);
    } else if (result === "not-running") {
      io.emit(`No running copytrade daemon named '${name}'.`);
    } else {
      io.emit(`Failed to signal copytrade daemon '${name}' (pid ${pid}). It may need a manual kill.`);
    }
    return { name, result, ...(pid !== undefined ? { pid } : {}) };
  }
}
