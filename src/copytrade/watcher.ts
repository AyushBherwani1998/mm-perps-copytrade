import { InfoClient, type ISubscription, SubscriptionClient, type WebSocketTransport } from "@nktkas/hyperliquid";

import type { Fill } from "./types.js";

export type WatcherCallbacks = {
  /** Every target fill we accept, before any copy decision. Observation only. */
  onFillSeen?: (target: `0x${string}`, fill: Fill, source: FillSource) => void;
  /** A fill from a target we copy, at or after `fromTs`. */
  onTargetFill: (target: `0x${string}`, fill: Fill, source: FillSource) => void | Promise<void>;
  /** One of our own fills (drives daily-PnL accounting). */
  onSelfFill: (fill: Fill) => void;
  /** The socket dropped and came back; a catch-up fetch has been issued. */
  onReconnect?: (sinceTs: number) => void;
  /** Non-fatal transport/handler error. */
  onError?: (err: unknown) => void;
};

export type FillSource = "live" | "backfill" | "recovery";

/** Hyperliquid caps a single `userFillsByTime` page; walk forward past it. */
const PAGE_LIMIT = 2_000;

/** Bound on remembered trade ids, so a long-lived daemon does not grow forever. */
const SEEN_CAP = 50_000;

/**
 * Subscribes to Hyperliquid `userFills` for each target plus our own address and
 * forwards new fills to the pipeline, de-duplicated by trade id.
 *
 * The live subscription alone is not sufficient: it delivers only a short
 * snapshot on connect and nothing at all for the window a dropped socket was
 * down. So history is fetched explicitly over REST — once at startup from
 * `fromTs`, and again after every reconnect from the last fill we saw — which is
 * what makes `--from` an actual backfill rather than a filter.
 */
export class FillWatcher {
  private readonly subs: ISubscription[] = [];

  private readonly seen = new Set<number>();

  private readonly client: SubscriptionClient;

  private readonly info: InfoClient;

  /** Highest fill timestamp accepted per target; the resume point after a drop. */
  private readonly highWater = new Map<string, number>();

  /** Live events that arrive while the startup backfill is still running. */
  private readonly primingQueue: { target: `0x${string}`; fills: Fill[] }[] = [];

  private priming = true;

  private connected = false;

  private catchUpChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: WebSocketTransport,
    private readonly cfg: { targets: `0x${string}`[]; self: `0x${string}`; fromTs: number }
  ) {
    this.client = new SubscriptionClient({ transport });
    this.info = new InfoClient({ transport });
  }

  async start(cb: WatcherCallbacks): Promise<void> {
    // Subscribe first and buffer, so fills landing during the backfill are not
    // lost in the gap between "history fetched" and "stream attached".
    for (const target of this.cfg.targets) {
      const sub = await this.client.userFills({ user: target }, (evt) => {
        const fills = evt.fills as unknown as Fill[];
        if (this.priming) {
          this.primingQueue.push({ target, fills });
          return;
        }
        void this.handleTarget(target, fills, cb, "live");
      });
      this.subs.push(sub);
      this.highWater.set(target.toLowerCase(), this.cfg.fromTs);
    }

    // Our own fills — only if distinct from a target, to avoid a redundant stream.
    if (!this.cfg.targets.some((t) => t.toLowerCase() === this.cfg.self.toLowerCase())) {
      const selfSub = await this.client.userFills({ user: this.cfg.self }, (evt) => {
        this.handleSelf(evt.fills as unknown as Fill[], cb);
      });
      this.subs.push(selfSub);
    }

    for (const target of this.cfg.targets) {
      await this.fetchHistory(target, this.cfg.fromTs, cb, "backfill");
    }

    this.priming = false;
    const queued = this.primingQueue.splice(0, this.primingQueue.length);
    for (const item of queued) {
      await this.handleTarget(item.target, item.fills, cb, "live");
    }

    this.connected = true;
    this.watchReconnects(cb);
  }

  /**
   * A reconnect means an unknown-length hole in the stream. Re-fetch each
   * target from its high-water mark; `seen` discards whatever we already had.
   */
  private watchReconnects(cb: WatcherCallbacks): void {
    this.transport.socket.addEventListener("close", () => {
      this.connected = false;
    });
    this.transport.socket.addEventListener("open", () => {
      if (this.connected) return; // initial connect, or an open we never saw drop
      this.connected = true;
      this.catchUpChain = this.catchUpChain.then(async () => {
        for (const target of this.cfg.targets) {
          const since = this.highWater.get(target.toLowerCase()) ?? this.cfg.fromTs;
          cb.onReconnect?.(since);
          try {
            await this.fetchHistory(target, since, cb, "recovery");
          } catch (err) {
            cb.onError?.(err);
          }
        }
      });
    });
  }

  /** Walk `userFillsByTime` forward from `startTime` and feed each fill through. */
  private async fetchHistory(
    target: `0x${string}`,
    startTime: number,
    cb: WatcherCallbacks,
    source: FillSource
  ): Promise<void> {
    let cursor = startTime;
    for (;;) {
      const page = (await this.info.userFillsByTime({ user: target, startTime: cursor })) as unknown as Fill[];
      if (page.length === 0) return;
      await this.handleTarget(target, page, cb, source);
      if (page.length < PAGE_LIMIT) return;
      // Advance past the last fill; +1ms avoids re-requesting the same page.
      const newest = page.reduce((max, f) => (f.time > max ? f.time : max), cursor);
      if (newest <= cursor) return;
      cursor = newest + 1;
    }
  }

  private async handleTarget(target: `0x${string}`, fills: Fill[], cb: WatcherCallbacks, source: FillSource): Promise<void> {
    // History pages arrive newest-first; replay in trade order so close
    // fractions are measured against the right prior position.
    const ordered = source === "live" ? fills : [...fills].sort((a, b) => a.time - b.time || a.tid - b.tid);
    for (const fill of ordered) {
      if (fill.time < this.cfg.fromTs) continue;
      if (this.markSeen(fill.tid)) continue;
      this.advanceHighWater(target, fill.time);
      cb.onFillSeen?.(target, fill, source);
      try {
        await cb.onTargetFill(target, fill, source);
      } catch (err) {
        cb.onError?.(err);
      }
    }
  }

  private advanceHighWater(target: `0x${string}`, time: number): void {
    const key = target.toLowerCase();
    const current = this.highWater.get(key) ?? 0;
    if (time > current) this.highWater.set(key, time);
  }

  private handleSelf(fills: Fill[], cb: WatcherCallbacks): void {
    for (const fill of fills) {
      // Self fills are keyed separately so a self==target run still counts both.
      if (this.markSeen(fill.tid, "self")) continue;
      try {
        cb.onSelfFill(fill);
      } catch (err) {
        cb.onError?.(err);
      }
    }
  }

  /** Returns true if this tid was already processed (for the given stream). */
  private markSeen(tid: number, stream: "target" | "self" = "target"): boolean {
    // Encode stream into the key space so the self stream never masks a target fill.
    const key = stream === "self" ? -tid - 1 : tid;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > SEEN_CAP) {
      // Sets iterate in insertion order, so this drops the oldest ids first.
      const drop = this.seen.size - SEEN_CAP;
      let i = 0;
      for (const old of this.seen) {
        if (i++ >= drop) break;
        this.seen.delete(old);
      }
    }
    return false;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.subs.map((s) => s.unsubscribe()));
    this.subs.length = 0;
    await this.catchUpChain.catch(() => undefined);
  }
}
