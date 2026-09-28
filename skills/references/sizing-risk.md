# Sizing, Leverage & Risk

How a target's fill becomes a mirrored order: **sizing** decides how much
**margin** to commit, **leverage** turns that margin into a size, and **risk
gates** can clamp or skip the order.

## Sizing modes (`--sizing`)

Sizing is always by **margin** — the capital the target commits to a trade — not
raw notional. The target's margin for a fill is
`(targetSize × price) / targetLeverage`. Each mode decides how much of *your*
margin to deploy; the size then follows from your leverage
(`size = margin × leverage / price`).

- `mirror` — deploy the same USD margin the target did (dollar-for-dollar). If
  they put $10 of margin in, so do you.
- `proportional` — the target's margin × (your equity / their equity), capped by
  `--max-scale`. Equities are read from public Hyperliquid clearinghouse state.
  You risk the same *fraction of your account* the target risked of theirs — a
  big-conviction trade from them becomes a big trade from you. Because the raw
  scale ratio is unbounded, `--max-scale` (e.g. `1`) is strongly recommended, or
  a bigger account silently amplifies every copy.
- `percent` — a fixed percentage of **your** account equity as margin, ignoring
  the target's size. `--percent 20` → margin = 20% of your equity, so
  notional = 0.20 × equity × leverage. Your equity is read from your clearinghouse
  state. Predictable and self-contained — unlike `proportional`, it does not
  depend on the target's equity or how much they committed.
- `fixed` — a constant `--fixed-margin` (USD) per entry, independent of the
  target.

`mirror` and `proportional` read the target's per-coin leverage from their live
position to compute their margin; if the target holds no position for the coin
(so leverage can't be read) the open is skipped. `percent` and `fixed` ignore the
target's size and leverage entirely and need only your own leverage (`percent`
also reads your equity). Sizes are rounded **down** to each asset's `szDecimals`
lot so Hyperliquid accepts them. Rounding down means an order right at the $10
notional minimum can fall below it — size a little above the floor.

`proportional` vs `percent`: both resolve to a fraction of your equity, but in
`proportional` the **target** sets the fraction (mirroring their conviction per
trade), while in `percent` **you** fix it for every entry. `percent` reads only
your equity; `proportional` reads both accounts' equity *and* the target's
leverage, so it's the most data-dependent mode.

## Leverage (`--leverage`, `--max-leverage`)

- `--leverage follow` (default) — match the target's live per-coin leverage. If
  the target does not currently hold the position, leverage can't be read and the
  open is skipped.
- `--leverage <n>` — use a fixed positive integer for every copied open.
- `--max-leverage <n>` — cap the effective leverage. It composes with both modes:
  - with `follow`, copy the trader's leverage but never above `n`;
  - with a numeric `--leverage m`, clamp to `min(m, n)`.

Per-asset maximum leverage varies on Hyperliquid (e.g. BTC 40x, ETH 25x, SOL
20x, many assets 10x). A leverage above an asset's max is rejected by the venue.

## Minimum order value and minimum margin

- Hyperliquid enforces a **$10 minimum order value** (notional). Copied orders
  below $10 are rejected — this applies to opens and to partial closes whose
  reduce-only value is under $10.
- Minimum margin per trade = `notional / leverage`. At the $10 minimum notional:

  | Effective leverage | Min margin |
  | --- | --- |
  | 40x (e.g. BTC max) | $0.25 |
  | 25x (e.g. ETH max) | $0.40 |
  | 20x (e.g. SOL max) | $0.50 |
  | 10x | $1.00 |
  | 5x | $2.00 |
  | 3x | ~$3.33 |

  A tighter `--max-leverage` therefore raises the free margin each entry needs.
  Add taker fees (~0.045%) and a buffer for maintenance margin on top.

## Closes and proportional exits

Closes mirror the **percentage** the target closed, not a fixed amount. The
target's close fraction is `min(1, closeSize / priorPosition)`; that same
fraction is applied to your current position for the symbol. So a 10% trader
close → a 10% close of your position. A near-full close (≥ 99.9%) collapses to a
full close. Set `--no-copy-closes` to leave exits to you.

Edge cases:
- If your position is small, a small percentage can round below the asset's lot
  size and the close is skipped (`partial close rounds to 0`).
- A partial close whose value is under Hyperliquid's $10 minimum can be rejected.

## Risk gates

All gates apply to **opens**; closes are never blocked (reducing exposure is
always allowed).

| Flag | Effect |
| --- | --- |
| `--max-order-notional <usd>` | Clamp any single order's notional |
| `--max-open-positions <n>` | Skip opens for new symbols beyond this count |
| `--daily-loss-limit <usd>` | Halt new opens after this realized USD loss in a UTC day |
| `--symbols <list>` | Allow list — only these symbols are copied |
| `--exclude-symbols <list>` | Deny list — these symbols are never copied |

A gate that clamps size reports the clamp; a gate that blocks reports a skip with
a reason. Daily-loss accounting uses your realized `closedPnl` fills for the
current UTC day.
