# Workflow: Diagnose failed or skipped copied orders

When a mirrored order does not go through, its log line has `status: failed` or
`status: skipped`. Work through these in order.

## 0. Read the log correctly

Each mirrored fill result line also carries a Node `punycode` deprecation
warning. A naive `grep -v DeprecationWarning` removes these lines and hides the
outcome — and the plugin can even capture that warning as the `reason` of a
failed order, masking the real error. Always read the raw file:

```bash
tail -n 40 ~/.metamask/copytrade/default.log
```

or read the JSON items without filtering that string.

## 1. `status: failed` with a masked / deprecation-warning reason

The real rejection is hidden. Reproduce the constraint out-of-band instead of
placing another live order:

```bash
mm perps balance --network mainnet
mm perps quote --venue hyperliquid --symbol <SYM> --side <long|short> \
  --size <size> --leverage <n> --network mainnet
```

Common causes:

- **Below the $10 minimum.** The quote returns e.g. "Order value $9.32 is below
  the Hyperliquid minimum of $10." The order notional is `margin × leverage`, so
  raise the margin (`--fixed-margin`, a larger `--percent`, a larger
  `--max-scale`, or a target that commits more margin for `mirror`) until notional
  clears $10 with headroom for lot-rounding. See
  [sizing-risk.md](../references/sizing-risk.md).
- **Insufficient free margin.** `mm perps balance` shows `spendableBalance: 0`
  (margin fully used). Fix: free margin (`mm perps positions` → `mm perps close`)
  or `mm perps deposit`. Minimum margin needed = `notional / leverage`.
- **Leverage above the asset max.** A followed/numeric leverage exceeds the
  asset's cap. Fix: set `--max-leverage` to clamp it.
- **MFA/password stall.** In guard/BYOK mode the underlying `mm perps` order
  waits for approval, which stalls a daemon. Fix: use server-wallet mode for
  unattended runs.

## 2. `status: skipped` reasons

- `could not resolve target leverage; pass --leverage <n>` — with
  `--leverage follow`, the target no longer holds the position. Pass a numeric
  `--leverage` (optionally with `--max-leverage`).
- `size rounds to 0 after risk clamp` / `partial close rounds to 0` — the sized
  order is below the asset lot size. Increase the margin (`--fixed-margin`,
  `--percent`, or `--max-scale`), relax `--max-order-notional`, or accept that
  tiny moves aren't copied.
- `target leverage unavailable for margin sizing` — with `mirror`/`proportional`,
  the target's per-coin leverage couldn't be read (they hold no position for the
  coin). Same cause as the `follow` skip below. (`percent` and `fixed` don't hit
  this — they ignore the target's leverage.)
- `percent sizing requires --percent` / `your account equity is unavailable for
  percent sizing` — pass `--percent <n>` for `--sizing percent`, and ensure your
  perps account has equity (`mm perps balance`).
- `fixed sizing requires --fixed-margin` — pass `--fixed-margin <usd>` for
  `--sizing fixed`.
- Risk-gate skips — `--max-open-positions`, `--daily-loss-limit`, or the
  allow/deny lists blocked the open. Adjust the relevant cap.

## 3. Nothing is copied at all

- The daemon uses `--from now`; a position opened **before** the run started is
  not backfilled. Use an epoch-ms `--from` to backfill.
- Confirm the daemon is actually running: `mm copytrade status`.
- Spot fills and modifications are ignored by design — only perp opens/closes are
  mirrored.

## 4. Command not found / plugin not registered

`mm copytrade …` reports "not found" or `mm plugins inspect perps-copytrade`
says "not installed" despite a successful-looking install — reinstall from a
tarball. See [install.md](../references/install.md).
