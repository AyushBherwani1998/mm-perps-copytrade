import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FillAggregator } from "./aggregator.js";
import { classifyFill } from "./classifier.js";
import type { Fill } from "./types.js";

function fill(overrides: Partial<Fill>): Fill {
  return {
    coin: "BTC",
    px: "78253.0",
    sz: "0.1",
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

const TARGET = "0xtarget" as `0x${string}`;

async function collect(
  fills: Fill[],
  opts: { windowMs?: number } = {}
): Promise<{ target: string; fill: Fill }[]> {
  const seen: { target: string; fill: Fill }[] = [];
  const agg = new FillAggregator((target, f) => void seen.push({ target, fill: f }), {
    windowMs: opts.windowMs ?? 10,
    maxWaitMs: 200,
  });
  for (const f of fills) agg.add(TARGET, f);
  await new Promise((r) => setTimeout(r, 60));
  await agg.drain();
  return seen;
}

describe("FillAggregator", () => {
  it("coalesces the partial fills of one book sweep into a single signal", async () => {
    // The real incident: one 10 BTC entry reported as 43 fills sharing a
    // timestamp and price, each with its own tid and a walking startPosition.
    const sizes = [
      0.41856, 0.35967, 0.15599, 1.35777, 0.10486, 0.09921, 0.09921, 0.09921, 0.09921, 0.46849, 0.13933, 0.001, 0.00077,
      0.00638, 1.02888, 0.44742, 0.09, 0.13591, 0.6964, 0.27972, 0.00766, 0.10349, 0.25, 0.025, 0.025, 0.25558, 0.002,
      0.00127, 0.13578, 0.00126, 0.00127, 0.38337, 0.03824, 0.25558, 0.12779, 0.38337, 0.15952, 0.10075, 0.44344,
      0.46569, 0.48696, 0.20263, 0.05636,
    ];
    let running = 0;
    const pieces = sizes.map((sz, i) => {
      const f = fill({ sz: String(sz), tid: i + 1, startPosition: String(running) });
      running += sz;
      return f;
    });

    const seen = await collect(pieces);

    assert.equal(seen.length, 1, "43 partial fills must produce exactly one mirrored signal");
    const total = sizes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(Number(seen[0].fill.sz) - total) < 1e-9, "aggregated size is the sum of the pieces");
    assert.ok(Math.abs(Number(seen[0].fill.px) - 78253) < 1e-6, "single-price sweep keeps that price");
    assert.equal(Number(seen[0].fill.startPosition), 0, "startPosition is the pre-sweep position");
  });

  it("volume-weights the price across levels", async () => {
    const seen = await collect([
      fill({ sz: "1", px: "100", tid: 1 }),
      fill({ sz: "3", px: "200", tid: 2 }),
    ]);

    assert.equal(seen.length, 1);
    assert.equal(Number(seen[0].fill.sz), 4);
    assert.equal(Number(seen[0].fill.px), 175); // (1*100 + 3*200) / 4
  });

  it("keeps separate symbols and directions apart", async () => {
    const seen = await collect([
      fill({ coin: "BTC", sz: "1", tid: 1 }),
      fill({ coin: "ETH", sz: "2", tid: 2 }),
      fill({ coin: "BTC", sz: "3", tid: 3, dir: "Close Long", startPosition: "10" }),
    ]);

    assert.equal(seen.length, 3, "distinct coin/direction groups stay separate");
    assert.deepEqual(
      seen.map((s) => `${s.fill.coin}:${s.fill.dir}:${s.fill.sz}`).sort(),
      ["BTC:Close Long:3", "BTC:Open Long:1", "ETH:Open Long:2"]
    );
  });

  it("flushes a pending open before a close on the same coin", async () => {
    const seen = await collect([
      fill({ sz: "1", tid: 1, dir: "Open Long" }),
      fill({ sz: "1", tid: 2, dir: "Close Long", startPosition: "1" }),
    ]);

    assert.deepEqual(
      seen.map((s) => s.fill.dir),
      ["Open Long", "Close Long"],
      "ordering must be preserved so we never close before opening"
    );
  });

  it("measures a partial close against the pre-sweep position", async () => {
    // Target holds 10 and sells 5 across three pieces: 50% of the position.
    const seen = await collect([
      fill({ dir: "Close Long", sz: "2", tid: 1, startPosition: "10" }),
      fill({ dir: "Close Long", sz: "2", tid: 2, startPosition: "8" }),
      fill({ dir: "Close Long", sz: "1", tid: 3, startPosition: "6" }),
    ]);

    assert.equal(seen.length, 1);
    const classified = classifyFill(seen[0].fill);
    assert.equal(classified.kind, "close");
    if (classified.kind !== "close") return;
    assert.equal(classified.size, 5);
    assert.equal(classified.fraction, 0.5, "5 of a pre-sweep 10 is a half close, not three near-full closes");
    assert.equal(classified.full, false);
  });

  it("recognises a full close swept across levels", async () => {
    const seen = await collect([
      fill({ dir: "Close Long", sz: "6", tid: 1, startPosition: "10" }),
      fill({ dir: "Close Long", sz: "4", tid: 2, startPosition: "4" }),
    ]);

    const classified = classifyFill(seen[0].fill);
    assert.equal(classified.kind, "close");
    if (classified.kind !== "close") return;
    assert.equal(classified.fraction, 1);
    assert.equal(classified.full, true);
  });

  it("emits nothing after dispose", async () => {
    const seen: Fill[] = [];
    const agg = new FillAggregator((_t, f) => void seen.push(f), { windowMs: 10, maxWaitMs: 100 });
    agg.add(TARGET, fill({ tid: 1 }));
    agg.dispose();
    await new Promise((r) => setTimeout(r, 40));
    await agg.drain();
    assert.equal(seen.length, 0, "buffered pieces must not fire orders during shutdown");
  });

  it("serializes emissions so mirrored orders never overlap", async () => {
    const order: string[] = [];
    const agg = new FillAggregator(
      async (_t, f) => {
        order.push(`start:${f.coin}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${f.coin}`);
      },
      { windowMs: 5, maxWaitMs: 100 }
    );
    agg.add(TARGET, fill({ coin: "BTC", tid: 1 }));
    agg.add(TARGET, fill({ coin: "ETH", tid: 2 }));
    await new Promise((r) => setTimeout(r, 120));
    await agg.drain();

    assert.equal(order.length, 4);
    assert.equal(order[0].startsWith("start:"), true);
    assert.equal(order[1], order[0].replace("start:", "end:"), "an order must finish before the next begins");
  });
});
