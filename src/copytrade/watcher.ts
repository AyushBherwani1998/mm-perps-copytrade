import { type ISubscription, SubscriptionClient, type WebSocketTransport } from "@nktkas/hyperliquid";

import type { Fill } from "./types.js";

export type WatcherCallbacks = {
  /** A fill from a target we copy, at or after `fromTs`. */
  onTargetFill: (target: `0x${string}`, fill: Fill) => void | Promise<void>;
  /** One of our own fills (drives daily-PnL accounting). */
  onSelfFill: (fill: Fill) => void;
  /** Non-fatal transport/handler error. */
  onError?: (err: unknown) => void;
};

/**
 * Subscribes to Hyperliquid `userFills` for each target plus our own address,
 * de-duplicates by trade id, and forwards new fills to the pipeline. The
 * underlying transport auto-resubscribes on reconnect (`resubscribe: true`).
 */
export class FillWatcher {
  private readonly subs: ISubscription[] = [];

  private readonly seen = new Set<number>();

  private readonly client: SubscriptionClient;

  constructor(
    transport: WebSocketTransport,
    private readonly cfg: { targets: `0x${string}`[]; self: `0x${string}`; fromTs: number }
  ) {
    this.client = new SubscriptionClient({ transport });
  }

  async start(cb: WatcherCallbacks): Promise<void> {
    for (const target of this.cfg.targets) {
      const sub = await this.client.userFills({ user: target }, (evt) => {
        void this.handleTarget(target, evt.fills as unknown as Fill[], cb);
      });
      this.subs.push(sub);
    }

    // Our own fills — only if distinct from a target, to avoid a redundant stream.
    if (!this.cfg.targets.some((t) => t.toLowerCase() === this.cfg.self.toLowerCase())) {
      const selfSub = await this.client.userFills({ user: this.cfg.self }, (evt) => {
        this.handleSelf(evt.fills as unknown as Fill[], cb);
      });
      this.subs.push(selfSub);
    }
  }

  private async handleTarget(target: `0x${string}`, fills: Fill[], cb: WatcherCallbacks): Promise<void> {
    for (const fill of fills) {
      if (this.markSeen(fill.tid)) continue;
      if (fill.time < this.cfg.fromTs) continue;
      try {
        await cb.onTargetFill(target, fill);
      } catch (err) {
        cb.onError?.(err);
      }
    }
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
    return false;
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.subs.map((s) => s.unsubscribe()));
    this.subs.length = 0;
  }
}
