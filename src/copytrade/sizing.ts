import { type HyperliquidReader, roundSize } from "./hyperliquid.js";
import type { RunConfig } from "./types.js";

export type SizingResult = { size: number; notionalUsd: number; marginUsd: number } | { skip: string };

/**
 * Compute the size of a mirrored OPEN, sizing by **margin** — the capital the
 * target commits — rather than raw notional.
 *
 * The target's margin for a fill is `(targetSize × price) / targetLeverage`.
 * How much of our own margin we deploy depends on `cfg.sizing`:
 *
 * - `mirror`: dollar-for-dollar — our margin equals the target's.
 * - `proportional`: the target's margin × (ourEquity / targetEquity), capped by
 *   `--max-scale`.
 * - `percent`: a fixed fraction of *our* account equity, independent of the
 *   target's size (e.g. 0.20 → 20% of our equity as margin).
 * - `fixed`: a constant `--fixed-margin` USD, independent of the target.
 *
 * `fixed` and `percent` don't read the target's size/leverage at all; the others
 * do. The order size then follows from *our* leverage: notional = margin ×
 * leverage, size = notional / price. Sizes are rounded down to the coin's
 * `szDecimals` so Hyperliquid accepts them.
 */
export async function sizeForOpen(
  cfg: RunConfig,
  reader: HyperliquidReader,
  params: { symbol: string; targetSize: number; price: number; target: string; ourLeverage: number; targetLeverage?: number }
): Promise<SizingResult> {
  const { symbol, targetSize, price, ourLeverage, targetLeverage } = params;

  if (!(ourLeverage > 0)) return { skip: "leverage unavailable for margin sizing" };

  const ourMargin = await resolveMargin(cfg, reader, { targetSize, price, target: params.target, targetLeverage });
  if (typeof ourMargin !== "number") return ourMargin;

  const rawSize = (ourMargin * ourLeverage) / price;
  const decimals = (await reader.getSzDecimals(symbol)) ?? 4;
  const size = roundSize(rawSize, decimals);
  if (!(size > 0)) return { skip: `rounded size is 0 (raw=${rawSize}, decimals=${decimals})` };

  return { size, notionalUsd: size * price, marginUsd: ourMargin };
}

/**
 * The USD margin we commit for this open, per `cfg.sizing`. Returns a positive
 * number, or a `{ skip }` describing why we can't size the trade.
 */
async function resolveMargin(
  cfg: RunConfig,
  reader: HyperliquidReader,
  params: { targetSize: number; price: number; target: string; targetLeverage?: number }
): Promise<number | { skip: string }> {
  const { targetSize, price, targetLeverage } = params;

  // fixed: a constant USD margin, independent of the target and our equity.
  if (cfg.sizing === "fixed") {
    if (!cfg.fixedMargin || cfg.fixedMargin <= 0) return { skip: "fixed sizing requires --fixed-margin" };
    return cfg.fixedMargin;
  }

  // percent: a fraction of *our* account equity, independent of the target.
  if (cfg.sizing === "percent") {
    if (!cfg.percentOfEquity || cfg.percentOfEquity <= 0) return { skip: "percent sizing requires --percent" };
    const self = await reader.getClearinghouse(cfg.self);
    if (!(self.accountValue > 0)) return { skip: "your account equity is unavailable for percent sizing" };
    const margin = self.accountValue * cfg.percentOfEquity;
    if (!(margin > 0)) return { skip: "computed margin is zero (no equity?)" };
    return margin;
  }

  // mirror / proportional both start from the target's committed margin.
  if (!(targetLeverage !== undefined && targetLeverage > 0)) {
    return { skip: "target leverage unavailable for margin sizing" };
  }
  const targetMargin = (targetSize * price) / targetLeverage;
  if (!(targetMargin > 0)) return { skip: "target margin is zero" };

  if (cfg.sizing === "mirror") return targetMargin;

  // proportional: scale the target's margin by our equity vs theirs.
  const [self, targetCh] = await Promise.all([reader.getClearinghouse(cfg.self), reader.getClearinghouse(params.target)]);
  if (!(targetCh.accountValue > 0)) return { skip: "target equity unavailable for proportional sizing" };
  let scale = self.accountValue / targetCh.accountValue;
  if (cfg.maxScale !== undefined) scale = Math.min(scale, cfg.maxScale);
  if (!(scale > 0)) return { skip: "computed scale is zero (no equity?)" };
  return targetMargin * scale;
}
