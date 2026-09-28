import { classifyFill } from "./classifier.js";
import type { PerpsExecutor } from "./executor.js";
import { type HyperliquidReader, roundSize } from "./hyperliquid.js";
import type { RiskManager } from "./risk.js";
import { sizeForOpen } from "./sizing.js";
import type { ActivityItem, Fill, RunConfig } from "./types.js";

/**
 * Turns a single target fill into at most one mirrored order, applying sizing,
 * risk gates, and (for closes) our own current position. Returns an
 * `ActivityItem` describing the outcome, or `null` for fills we silently ignore
 * (spot, unusable, or closes when `--no-copy-closes`).
 */
export class Pipeline {
  constructor(
    private readonly cfg: RunConfig,
    private readonly reader: HyperliquidReader,
    private readonly risk: RiskManager,
    private readonly executor: PerpsExecutor
  ) {}

  async handleTargetFill(target: `0x${string}`, fill: Fill): Promise<ActivityItem | null> {
    const classified = classifyFill(fill);
    if (classified.kind === "ignore") return null;

    if (classified.kind === "open") {
      return this.handleOpen(target, classified.symbol, classified.side, classified.size, classified.price);
    }

    if (!this.cfg.copyCloses) return null;
    return this.handleClose(target, classified.symbol, classified.fraction, classified.full);
  }

  private async handleOpen(
    target: `0x${string}`,
    symbol: string,
    side: "long" | "short",
    targetSize: number,
    price: number
  ): Promise<ActivityItem> {
    const base = { at: nowIso(), target, symbol, side } as const;

    // Resolve leverage first: margin-based sizing needs both our leverage (to
    // turn a margin amount into a size) and the target's per-coin leverage (to
    // read how much margin the target committed).
    const targetLeverage = (await this.reader.getClearinghouse(target)).positions.get(symbol)?.leverage;
    const leverage = this.resolveLeverage(targetLeverage);
    if (leverage === undefined) {
      return skip(base, "could not resolve target leverage; pass --leverage <n>");
    }

    const sized = await sizeForOpen(this.cfg, this.reader, {
      symbol,
      targetSize,
      price,
      target,
      ourLeverage: leverage,
      ...(targetLeverage !== undefined ? { targetLeverage } : {}),
    });
    if ("skip" in sized) return skip(base, sized.skip);

    const self = await this.reader.getClearinghouse(this.cfg.self);
    const decision = this.risk.evaluateOpen({
      symbol,
      size: sized.size,
      price,
      openPositionCount: self.positions.size,
      haveSymbol: self.positions.has(symbol),
    });
    if (!decision.allow) return skip(base, decision.reason);

    const decimals = (await this.reader.getSzDecimals(symbol)) ?? 4;
    const size = roundSize(decision.size, decimals);
    if (!(size > 0)) return skip(base, "size rounds to 0 after risk clamp");

    const notional = size * price;
    const notionalUsd = notional.toFixed(2);
    const marginUsd = (notional / leverage).toFixed(2);
    if (this.cfg.dryRun) {
      return { ...base, action: "open", size: String(size), notionalUsd, marginUsd, status: "dry-run" };
    }

    const res = await this.executor.open({ symbol, side, size: String(size), leverage });
    this.reader.invalidate(this.cfg.self);
    return res.ok
      ? { ...base, action: "open", size: String(size), notionalUsd, marginUsd, status: "placed", ...(res.orderId ? { orderId: res.orderId } : {}) }
      : { ...base, action: "open", size: String(size), notionalUsd, marginUsd, status: "failed", reason: res.error ?? "order failed" };
  }

  private async handleClose(target: `0x${string}`, symbol: string, fraction: number, targetFull: boolean): Promise<ActivityItem | null> {
    const base = { at: nowIso(), target, symbol } as const;

    const self = await this.reader.getClearinghouse(this.cfg.self);
    const pos = self.positions.get(symbol);
    if (!pos) return null; // nothing to close on our side

    const closeBase = { ...base, side: pos.side } as const;
    const full = targetFull;
    let sizeArg: string | undefined;
    if (!full) {
      const decimals = (await this.reader.getSzDecimals(symbol)) ?? 4;
      const closeSize = roundSize(pos.size * fraction, decimals);
      if (!(closeSize > 0)) return skip(closeBase, "partial close rounds to 0");
      // If the partial covers ~all of our position, fall back to a full close.
      sizeArg = closeSize >= pos.size ? undefined : String(closeSize);
    }

    if (this.cfg.dryRun) {
      return { ...closeBase, action: "close", size: sizeArg ?? String(pos.size), status: "dry-run" };
    }

    const res = await this.executor.close({ symbol, ...(sizeArg ? { size: sizeArg } : {}) });
    this.reader.invalidate(this.cfg.self);
    return res.ok
      ? { ...closeBase, action: "close", size: sizeArg ?? String(pos.size), status: "placed", ...(res.orderId ? { orderId: res.orderId } : {}) }
      : { ...closeBase, action: "close", size: sizeArg ?? String(pos.size), status: "failed", reason: res.error ?? "close failed" };
  }

  /**
   * Numeric override, or the target's live leverage for the coin when `follow`.
   * Either is clamped down to `--max-leverage` when set. `targetLeverage` is the
   * target's current per-coin leverage (undefined if they hold no position).
   */
  private resolveLeverage(targetLeverage: number | undefined): number | undefined {
    if (this.cfg.leverage !== "follow") return this.capLeverage(this.cfg.leverage);
    return targetLeverage === undefined ? undefined : this.capLeverage(targetLeverage);
  }

  private capLeverage(leverage: number): number {
    return this.cfg.maxLeverage !== undefined ? Math.min(leverage, this.cfg.maxLeverage) : leverage;
  }
}

function skip(base: { at: string; target: string; symbol: string; side?: "long" | "short" }, reason: string): ActivityItem {
  return { ...base, action: "skip", status: "skipped", reason };
}

function nowIso(): string {
  return new Date().toISOString();
}
