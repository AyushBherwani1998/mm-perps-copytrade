/** Shared types for the copytrade pipeline. */

export type PerpsNetwork = "mainnet" | "testnet";
export type PerpsSide = "long" | "short";

/**
 * How a target's trade is translated into ours. Sizing is always by **margin**
 * (the capital the target commits), never raw notional. In every mode the order
 * notional is `margin × your leverage`, and the order size is `notional / price`.
 *
 * - `mirror`: deploy the same USD margin the target did (dollar-for-dollar).
 * - `proportional`: the target's margin scaled by your equity vs theirs.
 * - `percent`: a fixed percentage of *your* account equity as margin, ignoring
 *   the target's size (e.g. 20% of equity → notional = 0.20 × equity × leverage).
 * - `fixed`: a constant USD margin per entry, ignoring the target's.
 */
export type SizingMode = "mirror" | "proportional" | "percent" | "fixed";

/** A raw Hyperliquid user fill (subset of fields we consume). */
export type Fill = {
  coin: string;
  px: string;
  sz: string;
  side: "B" | "A";
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: `0x${string}`;
  oid: number;
  tid: number;
};

/** The result of classifying a fill into a copy action. */
export type ClassifiedFill =
  | { kind: "open"; symbol: string; side: PerpsSide; size: number; price: number }
  | { kind: "close"; symbol: string; side: PerpsSide; size: number; price: number; fraction: number; full: boolean }
  | { kind: "ignore"; reason: string };

/** Fully-resolved run configuration. */
export type RunConfig = {
  targets: `0x${string}`[];
  self: `0x${string}`;
  venue: string;
  network: PerpsNetwork;
  sizing: SizingMode;
  /** USD margin per entry for `fixed` sizing. */
  fixedMargin?: number;
  /** Fraction of your account equity (0,1] committed as margin for `percent` sizing. */
  percentOfEquity?: number;
  maxScale?: number;
  leverage: number | "follow";
  /** Upper bound on the effective leverage; clamps both `follow` and a numeric `leverage`. */
  maxLeverage?: number;
  maxSlippageBps?: number;
  risk: RiskConfig;
  copyCloses: boolean;
  dryRun: boolean;
  /** Epoch ms; fills at or after this are copied. `0` copies nothing from the snapshot. */
  fromTs: number;
};

export type RiskConfig = {
  maxOrderNotional?: number;
  maxOpenPositions?: number;
  dailyLossLimit?: number;
  allowSymbols?: Set<string>;
  denySymbols?: Set<string>;
};

/** A streamed activity item (one per detected/mirrored event). */
export type ActivityItem = {
  at: string;
  target: string;
  action: "open" | "close" | "skip";
  symbol: string;
  side?: PerpsSide;
  size?: string;
  notionalUsd?: string;
  /** USD margin committed for this order (notional / leverage). */
  marginUsd?: string;
  status: "placed" | "dry-run" | "skipped" | "failed";
  reason?: string;
  orderId?: string;
};

/** Result returned when `start --daemon` forks a background worker and exits. */
export type DaemonLaunchResult = {
  daemon: true;
  name: string;
  pid: number;
  startedAt: string;
  logFile: string;
  targets: string[];
  network: PerpsNetwork;
  sizing: SizingMode;
  dryRun: boolean;
};

/** `copytrade start` returns either a foreground run summary or a daemon launch result. */
export type StartResult = RunSummary | DaemonLaunchResult;

/** End-of-run summary (the command's return value). */
export type RunSummary = {
  targets: string[];
  self: string;
  network: PerpsNetwork;
  sizing: SizingMode;
  dryRun: boolean;
  fillsSeen: number;
  ordersPlaced: number;
  ordersSkipped: number;
  ordersFailed: number;
  realizedPnlToday: string;
};
