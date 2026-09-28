---
name: perps-copytrade
description: Use when the user wants to copy-trade (mirror) another Hyperliquid trader's perpetual futures activity onto their MetaMask agent wallet — starting, stopping, checking, or tailing a copy-trade daemon; sizing, leverage, and risk controls for copied trades; installing the perps-copytrade mm plugin; or troubleshooting copied orders that fail. Entry point for the `mm copytrade` commands.
license: MIT
metadata:
  author: metamask
  version: "0.1.0"
  pluginPackage: perps-copytrade
  minCliVersion: ">=6.1.0 <8.0.0"
---

# Perps Copytrade Skill

This skill documents the `mm copytrade` command surface provided by the
`perps-copytrade` plugin. The plugin copies a Hyperliquid trader's perpetual
opens and closes onto the active MetaMask agent wallet in real time: it
subscribes to the target's fills over WebSocket, classifies each fill, sizes and
risk-gates a mirrored order, and shells out to the host `mm perps open/close`
commands to place it.

Use the routing table to select the relevant reference. Command behavior lives in
`references/`. End-to-end patterns live in `workflows/`.

## Command Routing

| User Intent | Command | Reference |
| --- | --- | --- |
| Install / enable the plugin | `mm plugins install` | [install.md](references/install.md) |
| Start copying a trader | `mm copytrade start` | [start.md](references/start.md) |
| Check whether a copier is running | `mm copytrade status` | [manage.md](references/manage.md) |
| Tail a copier's log | `mm copytrade logs` | [manage.md](references/manage.md) |
| Stop a copier | `mm copytrade stop` | [manage.md](references/manage.md) |
| Choose sizing, leverage, or risk caps | `mm copytrade start` flags | [sizing-risk.md](references/sizing-risk.md) |

## Workflows

| Pattern | Workflow |
| --- | --- |
| First-time setup and a live copy-trade run | [copy-trade-run.md](workflows/copy-trade-run.md) |
| Diagnose copied orders that fail or are skipped | [troubleshooting.md](workflows/troubleshooting.md) |

## Preflight

The plugin builds on the `mm` CLI. Before any `copytrade` command:

1. The host CLI must be authenticated and initialized — run `mm doctor` and
   confirm `authenticated: true` and `initialized: true`. If not, this is a host
   concern; defer to the `metamask-agent-wallet` skill's onboarding.
2. Plugins are experimental and off by default. Confirm
   `experimentalPlugins: true` with `mm config get`; enable with
   `mm config set experimentalPlugins true`.
3. The plugin must be installed and registered — `mm copytrade status --help`
   should resolve. If the command is "not found", see
   [install.md](references/install.md).

## Prerequisites for live copying

- Server-wallet mode is recommended for unattended daemons — it signs without a
  password prompt. In BYOK or guard mode, each mirrored order may pause for
  MFA/password approval, which stalls a daemon.
- The Hyperliquid perps account must hold enough free (spendable) USDC margin.
  Check with `mm perps balance`. A live open with `$0` spendable margin will be
  rejected even when sizing and configuration are correct.
- The read address (target's fills) and the wallet `mm perps` signs with both
  derive from the active wallet — keep them in sync with `mm wallet select`.

## Hyperliquid constraints that shape copied orders

- Sizing is by **margin** (the capital the target commits), not notional:
  `mirror` matches the trader's margin dollar-for-dollar, `proportional` scales it
  by your equity ratio, `percent` uses a fixed `--percent` of *your* equity, and
  `fixed` uses `--fixed-margin`. The resulting order notional is
  `margin × leverage`.
- Minimum order value is **$10 notional**. A copied order whose notional rounds
  below $10 is rejected. Because sizes round **down** to each asset's `szDecimals`
  lot, keep `margin × leverage` a little above $10 so it stays over the floor
  after rounding.
- Minimum margin per trade = `$10 / leverage`. Capping leverage with
  `--max-leverage` raises the minimum margin required (e.g. a 5x cap needs ≥ $2
  free margin per entry at the $10 minimum notional).
- Per-asset maximum leverage varies (e.g. BTC 40x, ETH 25x, SOL 20x, many 10x).
  A followed or numeric leverage above an asset's max is rejected by the venue.

## Safety Rules

- Copying is **live trading with real funds** unless `--dry-run` is set. Always
  confirm target(s), sizing mode and amount, leverage (and any cap), network, and
  risk caps before starting a non-dry run.
- Validate every target with `^0x[0-9a-fA-F]{40}$`. Reject anything else.
- Validate numeric flags: `--fixed-margin`, `--max-order-notional`,
  `--daily-loss-limit`, `--max-scale` are positive decimals; `--percent` is a
  number in `(0, 100]` (a percent like `20`, or a fraction like `0.2`);
  `--leverage` (numeric), `--max-leverage`, `--max-open-positions`,
  `--max-slippage-bps` are positive integers; `--leverage` may also be `follow`;
  `--network` is `mainnet` or `testnet`.
- Start on `--network testnet` or with `--dry-run` and small
  `--fixed-margin` / `--max-order-notional` when validating a new target or
  configuration.
- Stopping a copier only halts new mirroring — positions it already opened stay
  open. Manage them with `mm perps positions` / `mm perps close`.

## Output Rules

- Read logs from the raw log file or without filtering: each mirrored fill result
  is written on a line that also carries a Node `punycode` deprecation warning, so
  a naive `grep -v DeprecationWarning` hides the actual outcome. See
  [troubleshooting.md](workflows/troubleshooting.md).
- Surface command errors verbatim. If a command fails, check
  `mm copytrade <command> --help` and guide from there.
