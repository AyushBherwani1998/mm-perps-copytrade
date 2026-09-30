import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFill } from "./classifier.js";
import type { Fill } from "./types.js";

function fill(overrides: Partial<Fill>): Fill {
  return {
    coin: "WLD",
    px: "0.4761",
    sz: "100",
    side: "B",
    time: 1789727752749,
    startPosition: "0.0",
    dir: "Open Long",
    closedPnl: "0",
    hash: "0xhash",
    oid: 1,
    tid: 1,
    ...overrides,
  };
}

describe("classifyFill — flips", () => {
  it("splits a long>short flip into the close and the remaining short entry", () => {
    // Held +100, sold 150: exits the 100 long and enters 50 short.
    const res = classifyFill(fill({ dir: "Long > Short", startPosition: "100", sz: "150" }));
    assert.equal(res.kind, "flip");
    assert.partialDeepStrictEqual(res, { symbol: "WLD", from: "long", to: "short", openSize: 50 });
  });

  it("splits a short>long flip symmetrically", () => {
    const res = classifyFill(fill({ dir: "Short > Long", startPosition: "-40", sz: "100" }));
    assert.equal(res.kind, "flip");
    assert.partialDeepStrictEqual(res, { from: "short", to: "long", openSize: 60 });
  });

  it("treats a flip that only covers the old position as a plain full close", () => {
    const res = classifyFill(fill({ dir: "Long > Short", startPosition: "100", sz: "100" }));
    assert.equal(res.kind, "close");
    assert.partialDeepStrictEqual(res, { side: "long", full: true, fraction: 1 });
  });

  it("ignores a flip with no prior position", () => {
    const res = classifyFill(fill({ dir: "Long > Short", startPosition: "0", sz: "100" }));
    assert.equal(res.kind, "ignore");
  });
});

describe("classifyFill — opens and closes", () => {
  it("reads a partial close as a fraction of the prior position", () => {
    const res = classifyFill(fill({ dir: "Close Long", startPosition: "200", sz: "50" }));
    assert.equal(res.kind, "close");
    assert.partialDeepStrictEqual(res, { side: "long", fraction: 0.25, full: false });
  });

  it("collapses a near-total close to a full close", () => {
    const res = classifyFill(fill({ dir: "Close Long", startPosition: "100", sz: "99.95" }));
    assert.partialDeepStrictEqual(res, { kind: "close", full: true });
  });

  it("treats a liquidation as a close of the held side", () => {
    const res = classifyFill(fill({ dir: "Liquidated Cross", startPosition: "-10", sz: "10" }));
    assert.partialDeepStrictEqual(res, { kind: "close", side: "short", full: true });
  });

  it("ignores spot fills", () => {
    assert.equal(classifyFill(fill({ dir: "Buy" })).kind, "ignore");
  });
});
