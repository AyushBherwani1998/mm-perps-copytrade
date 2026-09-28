import type { ClassifiedFill, Fill } from "./types.js";

/**
 * Translate a Hyperliquid fill into a copy action from its `dir` label.
 *
 * Hyperliquid stamps each perp fill with a human `dir` such as `Open Long`,
 * `Close Short`, `Long > Short` (a flip), or `Buy`/`Sell` for spot. We mirror
 * only perp opens and closes; flips are surfaced as a close of the outgoing side
 * (the matching open arrives as its own fill). Spot and unknown labels are
 * ignored.
 */
export function classifyFill(fill: Fill): ClassifiedFill {
  const dir = fill.dir.trim();
  const size = Math.abs(Number(fill.sz));
  const price = Number(fill.px);
  const startPosition = Number(fill.startPosition);

  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
    return { kind: "ignore", reason: `unusable fill (sz=${fill.sz}, px=${fill.px})` };
  }

  // Spot fills carry Buy/Sell; we only copy perps.
  if (dir === "Buy" || dir === "Sell") {
    return { kind: "ignore", reason: "spot fill" };
  }

  if (dir.startsWith("Open ")) {
    const side = dir.endsWith("Long") ? "long" : dir.endsWith("Short") ? "short" : undefined;
    if (!side) return { kind: "ignore", reason: `unrecognized open dir '${dir}'` };
    return { kind: "open", symbol: fill.coin, side, size, price };
  }

  // Close (including liquidations) and flips both reduce/exit the outgoing side.
  const isClose = dir.startsWith("Close ") || dir.includes(">") || dir.startsWith("Liquidated");
  if (isClose) {
    // Outgoing side is inferred from the position held before the fill.
    const side = startPosition > 0 ? "long" : startPosition < 0 ? "short" : undefined;
    if (!side) return { kind: "ignore", reason: `close with no prior position ('${dir}')` };
    const prior = Math.abs(startPosition);
    const fraction = prior > 0 ? Math.min(1, size / prior) : 1;
    const full = fraction >= 0.999;
    return { kind: "close", symbol: fill.coin, side, size, price, fraction, full };
  }

  return { kind: "ignore", reason: `unhandled dir '${dir}'` };
}
