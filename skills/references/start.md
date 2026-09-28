# `mm copytrade start`

Copy a Hyperliquid trader's perps opens and closes in real time. Subscribes to
the target's fills over WebSocket and mirrors each onto the active wallet via
`mm perps open` / `mm perps close`. Runs in the foreground until Ctrl-C, or
detached in the background with `--daemon`.

## Syntax

```bash
mm copytrade start <target[,target2,...]> --sizing <mirror|proportional|percent|fixed> [flags]
```

The target(s) may be given positionally or with `--target`. Multiple targets are
comma-separated `0x` addresses.

## Flags

| Flag | Required | Description |
| --- | --- | --- |
| `target` / `--target` | Yes | Address(es) to copy (comma-separated `0x` addresses) |
| `--sizing <mirror\|proportional\|percent\|fixed>` | Yes | How much **margin** to commit per copied entry. See [sizing-risk.md](sizing-risk.md) |
| `--fixed-margin <usd>` | For `fixed` | USD margin per mirrored entry |
| `--percent <n>` | For `percent` | Percent of *your* account equity to use as margin per entry, e.g. `20`. Accepts `(0, 100]` (a fraction like `0.2` is also read as 20%) |
| `--max-scale <n>` | No | Cap on the proportional margin scale ratio (e.g. `1`) |
| `--leverage <n\|follow>` | No | Positive integer, or `follow` the target's per-coin leverage (default `follow`) |
| `--max-leverage <n>` | No | Cap the effective leverage; clamps both `follow` and a numeric `--leverage` down to `n` |
| `--max-slippage-bps <bps>` | No | Slippage cap in basis points for IOC pricing, passed to `mm perps` |
| `--max-order-notional <usd>` | No | Risk: clamp any single order to at most this USD notional |
| `--max-open-positions <n>` | No | Risk: stop opening new symbols beyond this count |
| `--daily-loss-limit <usd>` | No | Risk: halt new opens after this much realized USD loss in a UTC day |
| `--symbols <list>` | No | Risk: only copy these symbols (comma-separated allow list) |
| `--exclude-symbols <list>` | No | Risk: never copy these symbols (comma-separated deny list) |
| `--copy-closes` / `--no-copy-closes` | No | Mirror the target's closes (default true) |
| `--network <mainnet\|testnet>` | No | Default `mainnet` |
| `--venue <venue>` | No | Default `hyperliquid` |
| `--from <now\|epoch-ms>` | No | `now` copies only new fills (default); an epoch-ms timestamp backfills from that time |
| `--dry-run` | No | Log intended orders without signing or submitting |
| `--daemon` / `-d` | No | Run detached in the background; manage with `status`/`logs`/`stop` |
| `--name <id>` | No | Daemon instance name (default `default`); use distinct names to run several |

## Behavior notes

- `--from now` (default) means a position the target opened **before** the run
  started is not backfilled. To pick up an already-open position, pass an epoch-ms
  `--from` just before the fill you want.
- With `--leverage follow`, if the target does not currently hold the position,
  the leverage cannot be read and that open is **skipped** — pass a numeric
  `--leverage` (optionally with `--max-leverage`) to avoid this.
- Only opens and closes are mirrored. Modifications (leverage changes, TP/SL) are
  not. Spot fills are ignored. Flips are handled as a close of the outgoing side;
  the matching open arrives as its own fill.
- Each mirrored action is streamed as one NDJSON item on stdout plus a human line;
  a summary prints on exit (or is written to the daemon log).

## Examples

```bash
# Mirror the trader's margin dollar-for-dollar (they risk $10 → you risk $10)
mm copytrade start 0xTARGET --sizing mirror

# Fixed $12 margin per copied entry
mm copytrade start 0xTARGET --sizing fixed --fixed-margin 12

# 20% of YOUR account equity as margin per entry; cap leverage at 5x
mm copytrade start 0xTARGET --sizing percent --percent 20 --leverage follow --max-leverage 5

# Trader's margin scaled to your equity ratio; follow their leverage but never exceed 5x
mm copytrade start 0xTARGET --sizing proportional --max-scale 1 --leverage follow --max-leverage 5

# Several targets with risk caps and an allow list
mm copytrade start 0xA,0xB \
  --sizing fixed --fixed-margin 50 \
  --max-order-notional 200 --max-open-positions 5 \
  --daily-loss-limit 300 --symbols BTC,ETH

# Preview only — nothing is signed or submitted
mm copytrade start 0xTARGET --sizing mirror --dry-run

# Background daemon
mm copytrade start 0xTARGET --sizing fixed --fixed-margin 12 --daemon --name alpha
```
