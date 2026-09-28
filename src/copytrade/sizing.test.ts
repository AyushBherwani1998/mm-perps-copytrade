import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ClearinghouseSnapshot, HyperliquidReader } from "./hyperliquid.js";
import { sizeForOpen, type SizingResult } from "./sizing.js";
import type { RunConfig } from "./types.js";

/**
 * A stand-in for HyperliquidReader that serves canned account equity per address
 * and a fixed size-decimals value, so sizing can be tested without any network.
 */
class FakeReader {
  constructor(
    private readonly equityByAddress: Record<string, number>,
    private readonly szDecimals = 4
  ) {}

  async getClearinghouse(address: string): Promise<ClearinghouseSnapshot> {
    return { accountValue: this.equityByAddress[address.toLowerCase()] ?? 0, positions: new Map() };
  }

  async getSzDecimals(): Promise<number | undefined> {
    return this.szDecimals;
  }
}

const SELF = "0xself" as `0x${string}`;
const TARGET = "0xtarget" as `0x${string}`;

function makeCfg(overrides: Partial<RunConfig>): RunConfig {
  return {
    targets: [TARGET],
    self: SELF,
    venue: "hyperliquid",
    network: "mainnet",
    sizing: "mirror",
    leverage: "follow",
    risk: {},
    copyCloses: true,
    dryRun: false,
    fromTs: 0,
    ...overrides,
  };
}

/** Build a reader; equity map keys are lowercased addresses. */
function reader(equity: Record<string, number> = {}, szDecimals = 4): HyperliquidReader {
  return new FakeReader(equity, szDecimals) as unknown as HyperliquidReader;
}

function expectSized(result: SizingResult): { size: number; notionalUsd: number; marginUsd: number } {
  assert.ok(!("skip" in result), `expected a sized result, got skip: ${"skip" in result ? result.skip : ""}`);
  return result;
}

// A target position worth $20 notional at 2x leverage → the target committed $10
// of margin. price 100 → targetSize 0.2.
const TARGET_OPEN = { symbol: "BTC", targetSize: 0.2, price: 100, target: TARGET } as const;

describe("sizeForOpen — mirror (copy the trader's margin 1:1)", () => {
  it("matches the target's margin, and derives notional from OUR leverage", async () => {
    // Same leverage as the target → identical margin and notional.
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "mirror" }), reader(), {
        ...TARGET_OPEN,
        ourLeverage: 2,
        targetLeverage: 2,
      })
    );
    assert.equal(sized.marginUsd, 10); // same $10 margin the target used
    assert.equal(sized.notionalUsd, 20); // 10 margin × 2x
    assert.equal(sized.size, 0.2); // 20 / 100
  });

  it("keeps the margin fixed but scales notional when we use more leverage", async () => {
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "mirror" }), reader(), {
        ...TARGET_OPEN,
        ourLeverage: 5, // we run 5x instead of the target's 2x
        targetLeverage: 2,
      })
    );
    assert.equal(sized.marginUsd, 10); // margin still mirrors the target
    assert.equal(sized.notionalUsd, 50); // 10 margin × 5x
    assert.equal(sized.size, 0.5); // 50 / 100
  });

  it("skips when the target's leverage is unknown", async () => {
    const result = await sizeForOpen(makeCfg({ sizing: "mirror" }), reader(), {
      ...TARGET_OPEN,
      ourLeverage: 2,
      // targetLeverage omitted
    });
    assert.ok("skip" in result && result.skip.includes("target leverage"));
  });
});

describe("sizeForOpen — fixed (fixed margin × leverage = notional)", () => {
  it("uses the configured USD margin regardless of the target", async () => {
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "fixed", fixedMargin: 100 }), reader(), {
        ...TARGET_OPEN,
        ourLeverage: 3,
        targetLeverage: 2,
      })
    );
    assert.equal(sized.marginUsd, 100);
    assert.equal(sized.notionalUsd, 300); // 100 × 3x
    assert.equal(sized.size, 3); // 300 / 100
  });

  it("does not require the target's leverage", async () => {
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "fixed", fixedMargin: 50 }), reader(), {
        ...TARGET_OPEN,
        ourLeverage: 2,
        // targetLeverage omitted — fixed sizing ignores it
      })
    );
    assert.equal(sized.notionalUsd, 100); // 50 × 2x
  });

  it("skips when --fixed-margin is missing", async () => {
    const result = await sizeForOpen(makeCfg({ sizing: "fixed" }), reader(), {
      ...TARGET_OPEN,
      ourLeverage: 2,
      targetLeverage: 2,
    });
    assert.ok("skip" in result && result.skip.includes("fixed-margin"));
  });
});

describe("sizeForOpen — percent (% of your equity as margin × leverage = notional)", () => {
  it("commits the given fraction of our equity as margin", async () => {
    // 20% of a $1000 account = $200 margin.
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "percent", percentOfEquity: 0.2 }), reader({ [SELF]: 1000 }), {
        ...TARGET_OPEN,
        ourLeverage: 2,
        targetLeverage: 2,
      })
    );
    assert.equal(sized.marginUsd, 200); // 0.20 × 1000
    assert.equal(sized.notionalUsd, 400); // 200 × 2x
    assert.equal(sized.size, 4); // 400 / 100
  });

  it("ignores the target entirely (no target leverage needed)", async () => {
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "percent", percentOfEquity: 0.1 }), reader({ [SELF]: 500 }), {
        ...TARGET_OPEN,
        ourLeverage: 4,
        // targetLeverage omitted
      })
    );
    assert.equal(sized.marginUsd, 50); // 0.10 × 500
    assert.equal(sized.notionalUsd, 200); // 50 × 4x
  });

  it("skips when --percent is missing", async () => {
    const result = await sizeForOpen(makeCfg({ sizing: "percent" }), reader({ [SELF]: 1000 }), {
      ...TARGET_OPEN,
      ourLeverage: 2,
    });
    assert.ok("skip" in result && result.skip.includes("percent"));
  });

  it("skips when our account has no equity", async () => {
    const result = await sizeForOpen(makeCfg({ sizing: "percent", percentOfEquity: 0.2 }), reader({ [SELF]: 0 }), {
      ...TARGET_OPEN,
      ourLeverage: 2,
    });
    assert.ok("skip" in result && result.skip.includes("equity"));
  });
});

describe("sizeForOpen — proportional (target's margin scaled by equity ratio)", () => {
  it("scales the target's margin by our equity vs theirs", async () => {
    // We have half the target's equity → half their margin. Target margin $10.
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "proportional" }), reader({ [SELF]: 500, [TARGET]: 1000 }), {
        ...TARGET_OPEN,
        ourLeverage: 2,
        targetLeverage: 2,
      })
    );
    assert.equal(sized.marginUsd, 5); // 10 × (500 / 1000)
    assert.equal(sized.notionalUsd, 10); // 5 × 2x
  });

  it("caps the scale at --max-scale", async () => {
    // Equity ratio would be 2×, but max-scale 1 clamps it.
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "proportional", maxScale: 1 }), reader({ [SELF]: 2000, [TARGET]: 1000 }), {
        ...TARGET_OPEN,
        ourLeverage: 2,
        targetLeverage: 2,
      })
    );
    assert.equal(sized.marginUsd, 10); // clamped to 1× the target's $10 margin
  });

  it("skips when the target has no equity", async () => {
    const result = await sizeForOpen(makeCfg({ sizing: "proportional" }), reader({ [SELF]: 500, [TARGET]: 0 }), {
      ...TARGET_OPEN,
      ourLeverage: 2,
      targetLeverage: 2,
    });
    assert.ok("skip" in result && result.skip.includes("target equity"));
  });
});

describe("sizeForOpen — leverage & rounding guards", () => {
  it("skips when our leverage is not positive", async () => {
    const result = await sizeForOpen(makeCfg({ sizing: "fixed", fixedMargin: 100 }), reader(), {
      ...TARGET_OPEN,
      ourLeverage: 0,
      targetLeverage: 2,
    });
    assert.ok("skip" in result && result.skip.includes("leverage"));
  });

  it("rounds the size down to the coin's szDecimals", async () => {
    // margin 100 × 1x / price 30 = 3.333… → 2 decimals → 3.33.
    const sized = expectSized(
      await sizeForOpen(makeCfg({ sizing: "fixed", fixedMargin: 100 }), reader({}, 2), {
        symbol: "BTC",
        targetSize: 0.2,
        price: 30,
        target: TARGET,
        ourLeverage: 1,
      })
    );
    assert.equal(sized.size, 3.33);
  });

  it("skips when the rounded size collapses to 0", async () => {
    // margin 40 × 1x / price 100 = 0.4 → 0 decimals → 0.
    const result = await sizeForOpen(makeCfg({ sizing: "fixed", fixedMargin: 40 }), reader({}, 0), {
      symbol: "BTC",
      targetSize: 0.2,
      price: 100,
      target: TARGET,
      ourLeverage: 1,
    });
    assert.ok("skip" in result && result.skip.includes("rounded size is 0"));
  });
});
