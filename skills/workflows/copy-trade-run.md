# Workflow: First-time setup and a live copy-trade run

Use this to take a user from "I want to copy this trader" to a running copier,
safely.

## 1. Confirm the host CLI is ready

```bash
mm doctor
```

Require `authenticated: true` and `initialized: true`. If not, resolve with the
host `metamask-agent-wallet` skill (login / `mm init`) first.

## 2. Enable and install the plugin

```bash
mm config get                         # experimentalPlugins?
mm config set experimentalPlugins true
mm copytrade status --help            # resolves if already installed
```

If the command is not found, install it — see
[install.md](../references/install.md) (use the tarball route for local builds).

## 3. Confirm prerequisites for live trading

- Wallet mode: server-wallet is recommended for unattended daemons. In guard/BYOK
  mode, warn the user that each order may pause for MFA/password.
- Margin: check free (spendable) USDC in the perps account.

```bash
mm perps balance --network mainnet
```

If `spendableBalance` is `0`, live opens will be rejected. Have the user free
margin (`mm perps positions` then `mm perps close`) or deposit
(`mm perps deposit`) before starting a live run.

## 4. Decide configuration (confirm before a live run)

- Target address(es) — validate `^0x[0-9a-fA-F]{40}$`.
- Sizing (by margin): `mirror` (match the trader's margin dollar-for-dollar),
  `proportional` (their margin × your equity ratio, `--max-scale`), `percent`
  (a fixed `--percent` of *your* equity), or `fixed` (`--fixed-margin`). Every
  mode still produces an order that must clear Hyperliquid's $10 notional minimum
  after lot-rounding, so keep margin × leverage comfortably above $10. See
  [sizing-risk.md](../references/sizing-risk.md).
- Leverage: `follow`, a numeric value, and/or a `--max-leverage` cap.
- Network: `testnet` for a safe first run, else `mainnet`.
- Risk caps: `--max-order-notional`, `--max-open-positions`,
  `--daily-loss-limit`, `--symbols` / `--exclude-symbols`.

## 5. Dry-run first

```bash
mm copytrade start 0xTARGET --sizing mirror \
  --network mainnet --dry-run --daemon
mm copytrade logs --name default --follow
```

Watch it detect and size the target's fills without signing anything.

## 6. Go live

Stop the dry run, then start without `--dry-run`:

```bash
mm copytrade stop --name default
mm copytrade start 0xTARGET --sizing mirror \
  --network mainnet --daemon
```

## 7. Monitor

```bash
mm copytrade status --name default
mm copytrade logs --name default --follow   # read raw; do not filter DeprecationWarning
```

A successful mirror logs `status: placed` (or `✓`). Failures and skips carry a
reason — if a reason looks like a Node deprecation warning, see
[troubleshooting.md](troubleshooting.md).

## 8. Stop

```bash
mm copytrade stop --name default
```

Remind the user this halts new mirroring only; existing positions stay open.
