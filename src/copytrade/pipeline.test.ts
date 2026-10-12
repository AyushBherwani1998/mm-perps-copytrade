import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PerpsExecutor } from "./executor.js";
import type { HyperliquidReader } from "./hyperliquid.js";
import { Pipeline } from "./pipeline.js";
import { RiskManager } from "./risk.js";
import type { Fill, RunConfig } from "./types.js";

const TARGET = "0x00000000000000000000000000000000000000aa" as const;
const SELF = "0x00000000000000000000000000000000000000bb" as const;

function fill(overrides: Partial<Fill>): Fill {
  return {
    coin: "LTC",
    px: "64",
    sz: "10",
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

/** Target always holds the coin at 10x; we hold nothing, so every open sizes the same. */
const reader = {
  getClearinghouse: async (addr: string) => ({
    accountValue: 1_000,
    positions:
      addr.toLowerCase() === TARGET
        ? new Map([["LTC", { size: 10, side: "long" as const, leverage: 10 }]])
        : new Map(),
  }),
  getSzDecimals: async () => 2,
  invalidate: () => undefined,
} as unknown as HyperliquidReader;

function setup(overrides: Partial<RunConfig> = {}) {
  const opens: string[] = [];
  const executor = {
    open: async (p: { symbol: string }) => {
      opens.push(p.symbol);
      return { ok: true };
    },
    close: async () => ({ ok: true }),
  } as unknown as PerpsExecutor;
  const cfg: RunConfig = {
    targets: [TARGET],
    self: SELF,
    venue: "hyperliquid",
    network: "mainnet",
    sizing: "fixed",
    fixedMargin: 30,
    leverage: "follow",
    risk: {},
    copyCloses: true,
    copyAddsToExisting: false,
    dryRun: false,
    fromTs: 0,
    ...overrides,
  };
  return { pipeline: new Pipeline(cfg, reader, new RiskManager({}), executor), opens };
}

describe("Pipeline — positions that predate copying", () => {
  it("skips adds to an existing position, reporting it once", async () => {
    const { pipeline, opens } = setup();
    const first = await pipeline.handleTargetFill(TARGET, fill({ startPosition: "100" }));
    const second = await pipeline.handleTargetFill(TARGET, fill({ startPosition: "110", tid: 2 }));
    assert.equal(opens.length, 0);
    assert.partialDeepStrictEqual(first, [{ action: "skip", symbol: "LTC" }]);
    assert.deepEqual(second, []);
  });

  it("copies adds to an existing position under --copy-adds-to-existing", async () => {
    const { pipeline, opens } = setup({ copyAddsToExisting: true });
    await pipeline.handleTargetFill(TARGET, fill({ startPosition: "100" }));
    assert.equal(opens.length, 1);
  });

  it("still copies adds to a position it watched open", async () => {
    const { pipeline, opens } = setup();
    await pipeline.handleTargetFill(TARGET, fill({ startPosition: "0" }));
    await pipeline.handleTargetFill(TARGET, fill({ startPosition: "10", tid: 2 }));
    assert.equal(opens.length, 2);
  });

  it("treats a re-entry after a full close as fresh", async () => {
    const { pipeline, opens } = setup();
    await pipeline.handleTargetFill(TARGET, fill({ startPosition: "100" }));
    await pipeline.handleTargetFill(TARGET, fill({ dir: "Close Long", side: "A", startPosition: "100", sz: "100", tid: 2 }));
    await pipeline.handleTargetFill(TARGET, fill({ startPosition: "0", tid: 3 }));
    await pipeline.handleTargetFill(TARGET, fill({ startPosition: "10", tid: 4 }));
    assert.equal(opens.length, 2);
  });

  it("treats the new side of a flip as fresh", async () => {
    const { pipeline, opens } = setup();
    await pipeline.handleTargetFill(TARGET, fill({ dir: "Long > Short", side: "A", startPosition: "100", sz: "150" }));
    await pipeline.handleTargetFill(TARGET, fill({ dir: "Open Short", side: "A", startPosition: "-50", tid: 2 }));
    assert.equal(opens.length, 2);
  });
});
