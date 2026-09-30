import {
  CommandError,
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { WebSocketTransport } from "@nktkas/hyperliquid";

import { FillAggregator } from "../../copytrade/aggregator.js";
import { clearPidFile, spawnDaemon } from "../../copytrade/daemon.js";
import { PerpsExecutor } from "../../copytrade/executor.js";
import { HyperliquidReader } from "../../copytrade/hyperliquid.js";
import { sanitizeName } from "../../copytrade/paths.js";
import { Pipeline } from "../../copytrade/pipeline.js";
import { RiskManager } from "../../copytrade/risk.js";
import type { ActivityItem, DaemonLaunchResult, Fill, PerpsNetwork, RunConfig, RunSummary, SizingMode, StartResult } from "../../copytrade/types.js";

const inputs = {
  target: {
    type: InputFieldType.Text,
    flag: "target",
    message: "Address(es) to copy (comma-separated 0x addresses)",
    required: true,
    index: 0,
  },
  venue: {
    type: InputFieldType.Text,
    flag: "venue",
    message: "Perps venue (default hyperliquid)",
    required: false,
    prompt: false,
  },
  network: {
    type: InputFieldType.Select,
    flag: "network",
    message: "Network (default mainnet)",
    required: false,
    prompt: false,
    code: "INVALID_NETWORK",
    options: [
      { value: "mainnet", label: "mainnet" },
      { value: "testnet", label: "testnet" },
    ],
  },
  sizing: {
    type: InputFieldType.Select,
    flag: "sizing",
    message: "Sizing mode (by margin): mirror the trader's margin, scale it to your equity, a % of your equity, or a fixed margin per trade",
    required: true,
    prompt: true,
    code: "INVALID_SIZING",
    options: [
      { value: "mirror", label: "mirror — match the trader's margin dollar-for-dollar" },
      { value: "proportional", label: "proportional — the trader's margin scaled by your equity vs theirs" },
      { value: "percent", label: "percent — a fixed % of your account equity as margin per entry" },
      { value: "fixed", label: "fixed — set a fixed USD margin per copied entry" },
    ],
  },
  fixedMargin: {
    type: InputFieldType.Text,
    flag: "fixed-margin",
    message: "USD margin per entry (required for --sizing fixed)",
    required: false,
    prompt: false,
  },
  percent: {
    type: InputFieldType.Text,
    flag: "percent",
    message: "Percent of your account equity to use as margin per entry, e.g. 20 (required for --sizing percent)",
    required: false,
    prompt: false,
  },
  maxScale: {
    type: InputFieldType.Text,
    flag: "max-scale",
    message: "Cap on the proportional margin scale ratio (e.g. 1)",
    required: false,
    prompt: false,
  },
  leverage: {
    type: InputFieldType.Text,
    flag: "leverage",
    message: 'Leverage: a positive integer, or "follow" to match the target (default follow)',
    required: false,
    prompt: false,
  },
  maxLeverage: {
    type: InputFieldType.Text,
    flag: "max-leverage",
    message: "Cap the effective leverage; clamps both --leverage follow and a numeric --leverage (e.g. 5)",
    required: false,
    prompt: false,
  },
  maxSlippageBps: {
    type: InputFieldType.Text,
    flag: "max-slippage-bps",
    message: "Slippage cap in basis points for IOC pricing (e.g. 50)",
    required: false,
    prompt: false,
  },
  maxOrderNotional: {
    type: InputFieldType.Text,
    flag: "max-order-notional",
    message: "Risk: clamp any single order to at most this USD notional",
    required: false,
    prompt: false,
  },
  maxOpenPositions: {
    type: InputFieldType.Text,
    flag: "max-open-positions",
    message: "Risk: stop opening new symbols beyond this count",
    required: false,
    prompt: false,
  },
  dailyLossLimit: {
    type: InputFieldType.Text,
    flag: "daily-loss-limit",
    message: "Risk: halt new opens after this much realized USD loss in a UTC day",
    required: false,
    prompt: false,
  },
  symbols: {
    type: InputFieldType.Text,
    flag: "symbols",
    message: "Risk: only copy these symbols (comma-separated allow list)",
    required: false,
    prompt: false,
  },
  excludeSymbols: {
    type: InputFieldType.Text,
    flag: "exclude-symbols",
    message: "Risk: never copy these symbols (comma-separated deny list)",
    required: false,
    prompt: false,
  },
  copyCloses: {
    type: InputFieldType.Boolean,
    flag: "copy-closes",
    message: "Mirror the target's closes/exits (default true)",
    required: false,
    prompt: false,
    default: true,
  },
  dryRun: {
    type: InputFieldType.Boolean,
    flag: "dry-run",
    message: "Log intended orders without signing or submitting",
    required: false,
    prompt: false,
    default: false,
  },
  from: {
    type: InputFieldType.Text,
    flag: "from",
    message: '"now" to copy only new fills (default), or an epoch-ms timestamp to backfill from',
    required: false,
    prompt: false,
  },
  daemon: {
    type: InputFieldType.Boolean,
    flag: "daemon",
    aliases: ["d"],
    message: "Run detached in the background; survives closing the terminal. Manage with copytrade status/stop/logs",
    required: false,
    prompt: false,
    default: false,
  },
  name: {
    type: InputFieldType.Text,
    flag: "name",
    message: "Daemon instance name (default 'default'); use distinct names to run several at once",
    required: false,
    prompt: false,
  },
  foreground: {
    type: InputFieldType.Boolean,
    flag: "foreground",
    message: "(internal) run the worker loop in the foreground; set by --daemon on the forked child",
    required: false,
    prompt: false,
    default: false,
  },
} satisfies InputSchema;

export default class CopytradeStart extends PluginCommand<StartResult, ActivityItem> {
  static override description =
    "Copy a Hyperliquid trader's perps opens and closes in real time. Subscribes to the target's fills over " +
    "WebSocket and mirrors each onto your wallet via `mm perps open/close`. Runs in the foreground until Ctrl-C, " +
    "or detached in the background with --daemon.";

  static override examples = [
    "<%= config.bin %> copytrade start 0xTARGET --sizing mirror",
    "<%= config.bin %> copytrade start 0xTARGET --sizing fixed --fixed-margin 100",
    "<%= config.bin %> copytrade start 0xTARGET --sizing percent --percent 20 --leverage follow --max-leverage 5",
    "<%= config.bin %> copytrade start 0xTARGET --sizing proportional --max-scale 1 --leverage follow --max-leverage 5",
    "<%= config.bin %> copytrade start 0xA,0xB --sizing fixed --fixed-margin 50 --max-open-positions 5 --daily-loss-limit 200 --symbols BTC,ETH",
    "<%= config.bin %> copytrade start 0xTARGET --sizing mirror --daemon",
    "<%= config.bin %> copytrade start 0xTARGET --sizing fixed --fixed-margin 100 --dry-run",
  ];

  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  protected readonly pluginCommandId = "copytrade:start";

  async execute(io: CommandIO<ActivityItem>): Promise<StartResult> {
    const resolved = await io.resolveInputs(inputs);
    const cfg = this.buildConfig(resolved);

    if (resolved.daemon === true && resolved.foreground !== true) {
      return this.launchDaemon(io, resolved, cfg);
    }

    return this.runWorker(io, cfg, resolved.foreground === true ? sanitizeName(resolved.name ?? "default") : undefined);
  }

  /** Fork a detached background worker and return immediately. */
  private launchDaemon(io: CommandIO<ActivityItem>, resolved: ResolvedValues, cfg: RunConfig): DaemonLaunchResult {
    const name = sanitizeName(resolved.name ?? "default");
    const childArgs = buildChildArgs(this.argv, name);
    const meta = spawnDaemon({
      name,
      childArgs,
      meta: { name, targets: cfg.targets, network: cfg.network, sizing: cfg.sizing, dryRun: cfg.dryRun },
    });
    io.emit(
      `copytrade daemon '${name}' started (pid ${meta.pid}). Logs: ${meta.logFile}\n` +
        `  status: mm copytrade status --name ${name}\n` +
        `  stop:   mm copytrade stop --name ${name}`
    );
    return {
      daemon: true,
      name,
      pid: meta.pid,
      startedAt: meta.startedAt,
      logFile: meta.logFile,
      targets: cfg.targets,
      network: cfg.network,
      sizing: cfg.sizing,
      dryRun: cfg.dryRun,
    };
  }

  /** Run the copy loop in this process until interrupted. `daemonName` set when we are the forked child. */
  private async runWorker(io: CommandIO<ActivityItem>, cfg: RunConfig, daemonName: string | undefined): Promise<RunSummary> {
    const transport = new WebSocketTransport({ isTestnet: cfg.network === "testnet", resubscribe: true });
    const reader = new HyperliquidReader(transport);
    const risk = new RiskManager(cfg.risk);
    const executor = new PerpsExecutor({
      venue: cfg.venue,
      network: cfg.network,
      dryRun: cfg.dryRun,
      ...(cfg.maxSlippageBps !== undefined ? { maxSlippageBps: cfg.maxSlippageBps } : {}),
      onSpawn: (argv) => io.log("debug", `exec: ${argv.join(" ")}`),
    });
    const pipeline = new Pipeline(cfg, reader, risk, executor);

    // Lazy import keeps the module graph flat and avoids a hard dep cycle.
    const { FillWatcher } = await import("../../copytrade/watcher.js");
    const watcher = new FillWatcher(transport, { targets: cfg.targets, self: cfg.self, fromTs: cfg.fromTs });

    const summary: RunSummary = {
      targets: cfg.targets,
      self: cfg.self,
      network: cfg.network,
      sizing: cfg.sizing,
      dryRun: cfg.dryRun,
      fillsSeen: 0,
      fillsBackfilled: 0,
      reconnects: 0,
      ordersPlaced: 0,
      ordersSkipped: 0,
      ordersFailed: 0,
      realizedPnlToday: "0",
    };

    io.emit(
      `copytrade: watching ${cfg.targets.length} target(s) on ${cfg.network} · sizing=${cfg.sizing}` +
        `${cfg.dryRun ? " · DRY RUN" : ""} · press Ctrl-C to stop`
    );
    io.progress("Waiting for target fills...");

    // One aggressive target order arrives as many partial fills; coalesce them
    // into a single signal so we place one mirrored order per logical entry.
    const aggregator = new FillAggregator(
      async (target, fill) => {
        for (const item of await pipeline.handleTargetFill(target, fill)) {
          io.yield(item);
          io.emit(formatActivity(item));
          if (item.status === "placed" || item.status === "dry-run") summary.ordersPlaced += 1;
          else if (item.status === "failed") summary.ordersFailed += 1;
          else summary.ordersSkipped += 1;
        }
      },
      { onError: (err) => io.log("warn", `mirror error: ${errText(err)}`) }
    );

    await watcher.start({
      // Every target fill is recorded, whether or not it becomes an order, so
      // the log explains what the trader did and not just what we copied.
      onFillSeen: (target, fill, source) => {
        summary.fillsSeen += 1;
        if (source !== "live") summary.fillsBackfilled += 1;
        const item = observed(target, fill, source);
        io.yield(item);
        io.emit(formatActivity(item));
      },
      onTargetFill: (target, fill) => {
        aggregator.add(target, fill);
      },
      onSelfFill: (fill) => risk.recordSelfFill(fill),
      onReconnect: (sinceTs) => {
        summary.reconnects += 1;
        io.emit(`copytrade: socket reconnected — re-fetching target fills since ${new Date(sinceTs).toISOString()}`);
      },
      onError: (err) => io.log("warn", `watcher error: ${errText(err)}`),
    });

    // Block until interrupted: the host's AbortSignal (Ctrl-C in the REPL/TTY) or
    // a direct SIGINT/SIGTERM (Ctrl-C in a plain terminal, or `copytrade stop`).
    await waitForShutdown(io.signal);

    io.progress();
    await watcher.stop();
    // Drop buffered pieces rather than firing new orders on the way out.
    aggregator.dispose();
    await aggregator.drain();
    try {
      transport.close();
    } catch {
      // best-effort shutdown
    }
    if (daemonName) clearPidFile(daemonName);
    summary.realizedPnlToday = risk.realizedPnlToday.toFixed(2);
    return summary;
  }

  private buildConfig(v: ResolvedValues): RunConfig {
    const targets = splitAddresses(v.target);
    if (targets.length === 0) {
      throw new CommandError("COPYTRADE_NO_TARGET", "No valid 0x target address supplied.", "Pass --target 0x… (comma-separated for several).");
    }

    const sizing = v.sizing as SizingMode;
    const fixedMargin = parsePositive(v.fixedMargin, "--fixed-margin");
    if (sizing === "fixed" && fixedMargin === undefined) {
      throw new CommandError("COPYTRADE_MISSING_MARGIN", "--sizing fixed requires --fixed-margin.", "e.g. --fixed-margin 100");
    }

    const percentOfEquity = parsePercent(v.percent);
    if (sizing === "percent" && percentOfEquity === undefined) {
      throw new CommandError("COPYTRADE_MISSING_PERCENT", "--sizing percent requires --percent.", "e.g. --percent 20 (percent of your equity).");
    }

    const leverage = parseLeverage(v.leverage);
    const maxLeverage = parseMaxLeverage(v.maxLeverage);

    return {
      targets,
      self: this.resolveEvmAddress(),
      venue: v.venue ?? "hyperliquid",
      network: (v.network as PerpsNetwork) ?? "mainnet",
      sizing,
      ...(fixedMargin !== undefined ? { fixedMargin } : {}),
      ...(percentOfEquity !== undefined ? { percentOfEquity } : {}),
      ...(parsePositive(v.maxScale, "--max-scale") !== undefined ? { maxScale: parsePositive(v.maxScale, "--max-scale") } : {}),
      leverage,
      ...(maxLeverage !== undefined ? { maxLeverage } : {}),
      ...(parsePositive(v.maxSlippageBps, "--max-slippage-bps") !== undefined
        ? { maxSlippageBps: Math.round(parsePositive(v.maxSlippageBps, "--max-slippage-bps") as number) }
        : {}),
      risk: {
        ...(parsePositive(v.maxOrderNotional, "--max-order-notional") !== undefined
          ? { maxOrderNotional: parsePositive(v.maxOrderNotional, "--max-order-notional") }
          : {}),
        ...(parsePositive(v.maxOpenPositions, "--max-open-positions") !== undefined
          ? { maxOpenPositions: Math.floor(parsePositive(v.maxOpenPositions, "--max-open-positions") as number) }
          : {}),
        ...(parsePositive(v.dailyLossLimit, "--daily-loss-limit") !== undefined
          ? { dailyLossLimit: parsePositive(v.dailyLossLimit, "--daily-loss-limit") }
          : {}),
        ...(v.symbols ? { allowSymbols: splitSymbols(v.symbols) } : {}),
        ...(v.excludeSymbols ? { denySymbols: splitSymbols(v.excludeSymbols) } : {}),
      },
      copyCloses: v.copyCloses !== false,
      dryRun: v.dryRun === true,
      fromTs: parseFrom(v.from),
    };
  }

  /** Active EVM address: honor `mm wallet select`, else the first EVM wallet on file. */
  private resolveEvmAddress(): `0x${string}` {
    const state = this.ctx.walletStateManager.read();
    const evmByok = state.byokWallets.filter((w) => w.namespace === "evm");
    const evmRemote = state.remoteWallets.filter((w) => (w.namespace ?? "evm") === "evm");

    const selected = state.selectedWallet;
    if (selected && selected.namespace === "evm") {
      const pool = selected.mode === "byok" ? evmByok : evmRemote;
      const ref = selected.ref as { id?: string; address?: string; name?: string };
      const match = pool.find(
        (w) =>
          (ref.address && w.address.toLowerCase() === ref.address.toLowerCase()) ||
          (ref.name && w.name === ref.name) ||
          (ref.id && "id" in w && (w as { id?: string }).id === ref.id)
      );
      if (match) return match.address as `0x${string}`;
    }

    const fallback = evmByok[0] ?? evmRemote[0];
    if (!fallback) {
      throw new CommandError("COPYTRADE_NO_WALLET", "No EVM wallet found.", "Run `mm init` (or `mm wallet create`) first.");
    }
    return fallback.address as `0x${string}`;
  }

  override successHint(data: StartResult): string {
    if ("daemon" in data) {
      return `Daemon '${data.name}' running (pid ${data.pid})${data.dryRun ? " · DRY RUN" : ""}. Tail logs: mm copytrade logs --name ${data.name}`;
    }
    const recovered = data.fillsBackfilled > 0 ? ` (${data.fillsBackfilled} from history)` : "";
    const drops = data.reconnects > 0 ? ` · ${data.reconnects} reconnect(s)` : "";
    return (
      `Stopped. ${data.fillsSeen} target fill(s) seen${recovered}${drops} · ` +
      `${data.ordersPlaced} order(s) ${data.dryRun ? "simulated" : "placed"}, ${data.ordersSkipped} skipped, ${data.ordersFailed} failed · ` +
      `realized PnL today ${data.realizedPnlToday} USD`
    );
  }
}

type ResolvedValues = {
  target: string;
  venue?: string;
  network?: string;
  sizing: string;
  fixedMargin?: string;
  percent?: string;
  maxScale?: string;
  leverage?: string;
  maxLeverage?: string;
  maxSlippageBps?: string;
  maxOrderNotional?: string;
  maxOpenPositions?: string;
  dailyLossLimit?: string;
  symbols?: string;
  excludeSymbols?: string;
  copyCloses?: boolean;
  dryRun?: boolean;
  from?: string;
  daemon?: boolean;
  name?: string;
  foreground?: boolean;
};

/**
 * Reconstruct the child worker's argv from the launcher's raw argv: keep the
 * user's flags, drop the daemon-control flags, and force `--foreground` so the
 * child runs the loop instead of re-forking. The `--name` is carried through for
 * the child's own pid-file cleanup on shutdown.
 */
function buildChildArgs(argv: readonly string[], name: string): string[] {
  const kept: string[] = [];
  for (const token of argv) {
    if (token === "--daemon" || token === "-d") continue;
    kept.push(token);
  }
  const out = ["copytrade", "start", ...kept];
  if (!kept.includes("--foreground")) out.push("--foreground");
  if (!kept.includes("--name")) out.push("--name", name);
  return out;
}

function splitAddresses(raw: string): `0x${string}`[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s))
    .map((s) => s.toLowerCase() as `0x${string}`);
}

function splitSymbols(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

function parsePositive(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CommandError("COPYTRADE_BAD_NUMBER", `${flag} must be a positive number (got '${raw}').`, `Pass a positive number for ${flag}.`);
  }
  return n;
}

/**
 * Percent of account equity to commit as margin, returned as a fraction in
 * (0,1]. Accepts a percent like `20` (→ 0.20); values in (0,1] are treated as an
 * already-fractional input (`0.2` → 0.20). Rejects anything ≤ 0 or > 100.
 */
function parsePercent(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100) {
    throw new CommandError(
      "COPYTRADE_BAD_PERCENT",
      `--percent must be a number in (0, 100] (got '${raw}').`,
      "e.g. --percent 20 for 20% of your equity."
    );
  }
  return n <= 1 ? n : n / 100;
}

function parseLeverage(raw: string | undefined): number | "follow" {
  if (raw === undefined || raw === "" || raw.toLowerCase() === "follow") return "follow";
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError(
      "COPYTRADE_BAD_LEVERAGE",
      `--leverage must be a positive integer or "follow" (got '${raw}').`,
      'Use e.g. --leverage 5, or --leverage follow.'
    );
  }
  return n;
}

function parseMaxLeverage(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError(
      "COPYTRADE_BAD_MAX_LEVERAGE",
      `--max-leverage must be a positive integer (got '${raw}').`,
      "Use e.g. --max-leverage 5."
    );
  }
  return n;
}

function parseFrom(raw: string | undefined): number {
  if (!raw || raw.toLowerCase() === "now") return Date.now();
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new CommandError(
      "COPYTRADE_BAD_FROM",
      `--from must be "now" or an epoch-ms timestamp (got '${raw}').`,
      'Use --from now, or --from <epoch-ms>.'
    );
  }
  return n;
}

/** An observation of what the target did, independent of whether we mirrored it. */
function observed(target: `0x${string}`, fill: Fill, source: "live" | "backfill" | "recovery"): ActivityItem {
  return {
    at: new Date().toISOString(),
    target,
    action: "fill",
    symbol: fill.coin,
    status: "seen",
    size: fill.sz,
    price: fill.px,
    dir: fill.dir,
    fillTime: new Date(fill.time).toISOString(),
    tid: fill.tid,
    ...(source !== "live" ? { backfill: true } : {}),
  };
}

function formatActivity(item: ActivityItem): string {
  if (item.action === "fill") {
    const tag = item.backfill ? " (history)" : "";
    return `[fill] ${item.symbol} ${item.dir ?? ""} size=${item.size ?? "?"} @ ${item.price ?? "?"} · ${item.fillTime ?? ""}${tag}`;
  }
  const head = `[${item.action}] ${item.symbol}${item.side ? ` ${item.side}` : ""}`;
  const size = item.size ? ` size=${item.size}` : "";
  const margin = item.marginUsd ? ` margin=$${item.marginUsd}` : "";
  const notional = item.notionalUsd ? ` ($${item.notionalUsd})` : "";
  const tail =
    item.status === "placed"
      ? ` ✓${item.orderId ? ` order=${item.orderId}` : ""}`
      : item.status === "dry-run"
        ? " (dry-run)"
        : ` ✗ ${item.status}: ${item.reason ?? ""}`;
  return `${head}${size}${margin}${notional}${tail}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve when the run should stop: the host AbortSignal fires (Ctrl-C in the
 * REPL/TTY) or the process receives SIGINT/SIGTERM (Ctrl-C in a plain terminal,
 * or `copytrade stop` sending SIGTERM to a daemon).
 */
async function waitForShutdown(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}
