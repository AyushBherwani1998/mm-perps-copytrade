import { InfoClient, type WebSocketTransport } from "@nktkas/hyperliquid";

/** Thin, cached reader over Hyperliquid public info endpoints. */
export class HyperliquidReader {
  private readonly info: InfoClient;

  private szDecimals?: Map<string, number>;

  private readonly clearinghouseCache = new Map<string, { at: number; value: ClearinghouseSnapshot }>();

  private static readonly CH_TTL_MS = 2_000;

  constructor(transport: WebSocketTransport) {
    this.info = new InfoClient({ transport });
  }

  /** Base-asset size decimals per coin (needed to round order sizes HL will accept). */
  async getSzDecimals(coin: string): Promise<number | undefined> {
    if (!this.szDecimals) {
      const meta = await this.info.meta();
      this.szDecimals = new Map(meta.universe.map((u) => [u.name, u.szDecimals]));
    }
    return this.szDecimals.get(coin);
  }

  /** Account value + open positions for an address, cached briefly to avoid hammering the API. */
  async getClearinghouse(address: string): Promise<ClearinghouseSnapshot> {
    const key = address.toLowerCase();
    const cached = this.clearinghouseCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < HyperliquidReader.CH_TTL_MS) {
      return cached.value;
    }
    const state = await this.info.clearinghouseState({ user: address as `0x${string}` });
    const positions = new Map<string, Position>();
    for (const ap of state.assetPositions) {
      const szi = Number(ap.position.szi);
      if (!Number.isFinite(szi) || szi === 0) continue;
      positions.set(ap.position.coin, { size: Math.abs(szi), side: szi > 0 ? "long" : "short", leverage: ap.position.leverage.value });
    }
    const value: ClearinghouseSnapshot = { accountValue: Number(state.marginSummary.accountValue), positions };
    this.clearinghouseCache.set(key, { at: now, value });
    return value;
  }

  /** Invalidate the cached snapshot for an address (e.g. right after we place an order). */
  invalidate(address: string): void {
    this.clearinghouseCache.delete(address.toLowerCase());
  }
}

export type Position = { size: number; side: "long" | "short"; leverage: number };
export type ClearinghouseSnapshot = { accountValue: number; positions: Map<string, Position> };

/** Round a size down to `decimals` places; HL rejects orders with excess precision. */
export function roundSize(size: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(size * factor) / factor;
}
