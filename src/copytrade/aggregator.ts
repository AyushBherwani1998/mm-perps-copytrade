import type { Fill } from "./types.js";

export type AggregatorOptions = {
  /** Quiet period after the last piece before a group is emitted. */
  windowMs?: number;
  /** Hard cap on how long a group may keep absorbing pieces. */
  maxWaitMs?: number;
  /** Called when an emission throws, instead of dropping the error. */
  onError?: (err: unknown) => void;
};

type Group = {
  target: `0x${string}`;
  first: Fill;
  size: number;
  /** Σ(size × price), for the volume-weighted average price. */
  notional: number;
  pieces: number;
  timer: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
};

const DEFAULT_WINDOW_MS = 1_500;
const DEFAULT_MAX_WAIT_MS = 5_000;

/**
 * Coalesces the partial fills of a single logical order into one signal.
 *
 * An aggressive Hyperliquid order sweeps the book and reports one fill per
 * price level it consumes — a single 10 BTC market entry can arrive as 40+
 * fills sharing a timestamp and price, each with its own `tid`. Mirroring each
 * piece would place one order per level, and under `fixed`/`percent` sizing
 * (which ignore the target's size) that multiplies the intended margin by the
 * number of levels.
 *
 * Pieces are grouped by target + coin + direction and flushed after a quiet
 * period. The emitted fill carries the summed size, the volume-weighted price,
 * and the *first* piece's `startPosition` — the position before the whole
 * sweep — so close fractions are measured against the pre-sweep position
 * instead of each intermediate step.
 */
export class FillAggregator {
  private readonly pending = new Map<string, Group>();

  private readonly windowMs: number;

  private readonly maxWaitMs: number;

  private readonly onError: ((err: unknown) => void) | undefined;

  /** Serializes emissions so mirrored orders never overlap or reorder. */
  private chain: Promise<void> = Promise.resolve();

  private disposed = false;

  constructor(
    private readonly emit: (target: `0x${string}`, fill: Fill) => void | Promise<void>,
    opts: AggregatorOptions = {}
  ) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.onError = opts.onError;
  }

  add(target: `0x${string}`, fill: Fill): void {
    if (this.disposed) return;

    const size = Math.abs(Number(fill.sz));
    const price = Number(fill.px);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
      // Unusable numbers: pass through untouched so the classifier can log why.
      this.enqueue(target, fill);
      return;
    }

    const key = groupKey(target, fill);

    // A different action on the same coin (e.g. a close after an open) must not
    // overtake a group still absorbing pieces — flush that one first.
    for (const [otherKey, group] of this.pending) {
      if (otherKey !== key && group.target === target && group.first.coin === fill.coin) {
        this.flush(otherKey);
      }
    }

    const existing = this.pending.get(key);
    if (existing) {
      // Replayed history arrives far faster than it happened, so wall-clock
      // timers alone would fuse unrelated entries days apart into one order.
      // Only coalesce pieces that were actually part of the same sweep.
      if (Math.abs(fill.time - existing.first.time) > this.maxWaitMs) {
        this.flush(key);
      } else {
        existing.size += size;
        existing.notional += size * price;
        existing.pieces += 1;
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => this.flush(key), this.windowMs);
        return;
      }
    }

    this.pending.set(key, {
      target,
      first: fill,
      size,
      notional: size * price,
      pieces: 1,
      timer: setTimeout(() => this.flush(key), this.windowMs),
      deadline: setTimeout(() => this.flush(key), this.maxWaitMs),
    });
  }

  private flush(key: string): void {
    const group = this.pending.get(key);
    if (!group) return;
    this.pending.delete(key);
    clearTimeout(group.timer);
    clearTimeout(group.deadline);

    const vwap = group.notional / group.size;
    const merged: Fill = {
      ...group.first,
      sz: String(group.size),
      px: String(vwap),
    };
    this.enqueue(group.target, merged);
  }

  /** Chain emissions so the pipeline handles one aggregated fill at a time. */
  private enqueue(target: `0x${string}`, fill: Fill): void {
    this.chain = this.chain.then(() => this.emit(target, fill)).then(
      () => undefined,
      (err) => {
        this.onError?.(err);
      }
    );
  }

  /** Drop buffered pieces without emitting — used on shutdown. */
  dispose(): void {
    this.disposed = true;
    for (const group of this.pending.values()) {
      clearTimeout(group.timer);
      clearTimeout(group.deadline);
    }
    this.pending.clear();
  }

  /** Resolves once every emission queued so far has settled. */
  async drain(): Promise<void> {
    await this.chain;
  }
}

function groupKey(target: `0x${string}`, fill: Fill): string {
  return `${target}|${fill.coin}|${fill.dir.trim()}`;
}
