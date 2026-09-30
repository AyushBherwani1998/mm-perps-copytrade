import type { ClassifiedFill, Fill } from "./types.js";

/**
 * Translate a Hyperliquid fill into a copy action from its `dir` label.
 *
 * Hyperliquid stamps each perp fill with a human `dir` such as `Open Long`,
 * `Close Short`, `Long > Short` (a flip), or `Buy`/`Sell` for spot. We mirror
 * only perp opens and closes. Spot and unknown labels are ignored.
 *
 * A flip arrives as a *single* fill whose size spans both legs: it closes the
 * whole outgoing position and opens the remainder on the other side. It is
 * classified as `flip` so the pipeline can emit both legs; treating it as a
 * close alone would exit the old side and never enter the new one.
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

  // Outgoing side is inferred from the position held before the fill.
  const from = startPosition > 0 ? "long" : startPosition < 0 ? "short" : undefined;

  if (dir.includes(">")) {
    if (!from) return { kind: "ignore", reason: `flip with no prior position ('${dir}')` };
    // Size beyond the old position is the new side's entry.
    const openSize = size - Math.abs(startPosition);
    if (!(openSize > 0)) {
      // Degenerate flip that only closed: fall through to a plain full close.
      return { kind: "close", symbol: fill.coin, side: from, size, price, fraction: 1, full: true };
    }
    return { kind: "flip", symbol: fill.coin, from, to: from === "long" ? "short" : "long", openSize, price };
  }

  if (dir.startsWith("Close ") || dir.startsWith("Liquidated")) {
    if (!from) return { kind: "ignore", reason: `close with no prior position ('${dir}')` };
    const prior = Math.abs(startPosition);
    const fraction = prior > 0 ? Math.min(1, size / prior) : 1;
    const full = fraction >= 0.999;
    return { kind: "close", symbol: fill.coin, side: from, size, price, fraction, full };
  }

  return { kind: "ignore", reason: `unhandled dir '${dir}'` };
}
