import type { Fill, RiskConfig } from "./types.js";

export type OpenDecision = { allow: true; size: number; notionalUsd: number } | { allow: false; reason: string };

/**
 * Applies the configured risk gates to prospective OPEN orders and tracks
 * realized PnL for the current UTC day (fed from our own fills).
 *
 * Closes are intentionally never gated — reducing exposure is always allowed.
 */
export class RiskManager {
  private realizedToday = 0;

  private dayKey = utcDayKey(Date.now());

  constructor(private readonly cfg: RiskConfig) {}

  /** Accumulate realized PnL from one of *our* fills, rolling over at UTC midnight. */
  recordSelfFill(fill: Fill): void {
    this.rollIfNeeded(Date.now());
    // Only fills dated to the current UTC day count toward today's realized PnL;
    // older snapshot fills (e.g. after a restart) are ignored.
    if (utcDayKey(fill.time) !== this.dayKey) return;
    const pnl = Number(fill.closedPnl);
    if (Number.isFinite(pnl)) this.realizedToday += pnl;
  }

  get realizedPnlToday(): number {
    this.rollIfNeeded(Date.now());
    return this.realizedToday;
  }

  /**
   * Decide whether (and at what size) a mirrored open may proceed.
   *
   * @param openPositionCount current number of distinct open symbols we hold
   * @param haveSymbol whether we already hold a position in this symbol
   */
  evaluateOpen(params: {
    symbol: string;
    size: number;
    price: number;
    openPositionCount: number;
    haveSymbol: boolean;
  }): OpenDecision {
    const { symbol, price, openPositionCount, haveSymbol } = params;
    let { size } = params;

    if (this.cfg.denySymbols?.has(symbol)) {
      return { allow: false, reason: `symbol ${symbol} is on the deny list` };
    }
    if (this.cfg.allowSymbols && !this.cfg.allowSymbols.has(symbol)) {
      return { allow: false, reason: `symbol ${symbol} is not on the allow list` };
    }

    if (this.cfg.dailyLossLimit !== undefined && this.realizedPnlToday <= -Math.abs(this.cfg.dailyLossLimit)) {
      return { allow: false, reason: `daily loss limit hit (realized ${this.realizedPnlToday.toFixed(2)} USD today)` };
    }

    if (
      this.cfg.maxOpenPositions !== undefined &&
      !haveSymbol &&
      openPositionCount >= this.cfg.maxOpenPositions
    ) {
      return { allow: false, reason: `max open positions reached (${this.cfg.maxOpenPositions})` };
    }

    let notionalUsd = size * price;
    if (this.cfg.maxOrderNotional !== undefined && notionalUsd > this.cfg.maxOrderNotional) {
      size = this.cfg.maxOrderNotional / price;
      notionalUsd = size * price;
      if (!(size > 0)) return { allow: false, reason: "max order notional clamps size to 0" };
    }

    return { allow: true, size, notionalUsd };
  }

  private rollIfNeeded(atMs: number): void {
    const key = utcDayKey(atMs);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.realizedToday = 0;
    }
  }
}

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
