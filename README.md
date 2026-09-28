# perps-copytrade

Copy a Hyperliquid trader's perps opens and closes onto your MetaMask agent
wallet, mirrored in real time.

`perps-copytrade` is a plugin for the [`mm` CLI](https://www.npmjs.com/package/@metamask/agent-wallet)
(`@metamask/agent-wallet`) that adds a `mm copytrade` command topic. 

## Installation

```bash
mm config set experimentalPlugins true
mm plugins install perps-copytrade
```

## Usage

```bash
# Mirror the trader's margin dollar-for-dollar (they risk $10 → you risk $10)
mm copytrade start 0xTARGET --sizing mirror

# Fixed $100 margin per copied entry
mm copytrade start 0xTARGET --sizing fixed --fixed-margin 100

# 20% of YOUR account equity as margin per entry
mm copytrade start 0xTARGET --sizing percent --percent 20 --leverage follow --max-leverage 5

# The trader's margin scaled to your equity vs theirs, capped at 1x, following their leverage
mm copytrade start 0xTARGET --sizing proportional --max-scale 1 --leverage follow

# Multiple targets, with risk caps and an allow list
mm copytrade start 0xA,0xB \
  --sizing fixed --fixed-margin 50 \
  --max-order-notional 200 --max-open-positions 5 \
  --daily-loss-limit 300 --symbols BTC,ETH

# Preview only — nothing is signed or submitted
mm copytrade start 0xTARGET --sizing mirror --dry-run
```

Runs until `Ctrl-C`. Each mirrored action is streamed as an NDJSON item on
stdout (pipe-friendly) with a human line on stderr; a summary prints on exit.

Add `--daemon` to run detached in the background, then manage it with
`status` / `logs` / `stop`:

```bash
mm copytrade start 0xTARGET --sizing mirror --daemon
mm copytrade status
mm copytrade logs --follow
mm copytrade stop
```

Run several at once by giving each a `--name`.

## Flags

| Flag | Description |
| --- | --- |
| `target` (positional / `--target`) | Address(es) to copy, comma-separated |
| `--sizing <mirror\|proportional\|percent\|fixed>` | Required. Margin-based sizing mode |
| `--fixed-margin <usd>` | Required for `fixed`. USD margin per entry |
| `--percent <n>` | Required for `percent`. Percent of your equity as margin, e.g. `20` (accepts `(0,100]`) |
| `--max-scale <n>` | Cap on the proportional margin scale ratio |
| `--leverage <n\|follow>` | Positive integer, or `follow` the target (default `follow`) |
| `--max-leverage <n>` | Cap the effective leverage; clamps both `follow` and a numeric `--leverage` down to `n` |
| `--max-slippage-bps <bps>` | IOC slippage cap, passed through to `mm perps` |
| `--max-order-notional <usd>` | Risk: clamp any single order |
| `--max-open-positions <n>` | Risk: cap distinct open symbols |
| `--daily-loss-limit <usd>` | Risk: halt new opens after this realized loss (UTC day) |
| `--symbols <list>` / `--exclude-symbols <list>` | Risk: allow / deny lists |
| `--copy-closes` | Mirror closes (default true; `--no-copy-closes` to disable) |
| `--network <mainnet\|testnet>` | Default `mainnet` |
| `--venue <venue>` | Default `hyperliquid` |
| `--from <now\|epoch-ms>` | Skip backfill (default `now`) |
| `--dry-run` | Log intended orders without submitting |
| `--daemon [--name <id>]` | Start as a background daemon |

## Sizing

Sizing is always by **margin** — the capital the target commits to a trade —
not raw notional. The target's margin for a fill is
`(targetSize × price) / targetLeverage`. Each mode decides how much of *your*
margin to deploy; the order size then follows from your leverage
(`size = margin × leverage / price`).

| Mode | Margin deployed | Needs target's leverage? |
| --- | --- | --- |
| `mirror` | Same USD margin the target did (dollar-for-dollar) | Yes |
| `proportional` | Target's margin × (your equity / their equity), capped by `--max-scale` | Yes |
| `percent` | `--percent` % of **your** equity, ignoring the target's size | No |
| `fixed` | Constant `--fixed-margin` USD, independent of the target | No |

`mirror` and `proportional` read the target's per-coin leverage from their live
position, so they behave like `--leverage follow` for reading margin.
`proportional`'s equities are read from public Hyperliquid clearinghouse state;
the raw scale is unbounded, so `--max-scale` is strongly recommended. `percent`
reads only your own equity. Sizes are rounded down to each asset's `szDecimals`
so Hyperliquid accepts them.
