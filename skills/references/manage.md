# Managing copytrade daemons

A copier started with `--daemon` runs detached and survives closing the terminal.
State for each named instance lives under `~/.metamask/copytrade/<name>.{pid,log,json}`.
The default instance name is `default`.

## `mm copytrade status`

Show whether a copier is running and its resolved config.

```bash
mm copytrade status [--name <id>]
```

Reports `running`, `pid`, `startedAt`, `targets`, `network`, `sizing`, `dryRun`,
and the `logFile` path.

## `mm copytrade logs`

Tail a daemon's log.

```bash
mm copytrade logs [--name <id>] [--lines <n>] [--follow]
```

| Flag | Description |
| --- | --- |
| `--name <id>` | Instance to read (default `default`) |
| `--lines <n>` | Number of lines to show |
| `--follow` | Stream new lines as they arrive |

> When reading logs programmatically, read the raw file
> (`~/.metamask/copytrade/<name>.log`) or do **not** filter on
> `DeprecationWarning`. Each mirrored fill result line also carries a Node
> `punycode` deprecation warning, so filtering that string hides the real
> outcome (including the actual failure reason).

## `mm copytrade stop`

Stop a running daemon.

```bash
mm copytrade stop [--name <id>]
```

Sends `SIGTERM`, triggering the same graceful shutdown as Ctrl-C: unsubscribe,
print a summary to the log, and remove the PID file.

**Stopping only halts new mirroring.** Any positions the copier already opened
remain open. Review and exit them with `mm perps positions` and
`mm perps close`.

## Running several at once

Give each instance a distinct `--name`:

```bash
mm copytrade start 0xA --sizing fixed --fixed-margin 20 --daemon --name alpha
mm copytrade start 0xB --sizing proportional --daemon --name beta
mm copytrade status --name beta
mm copytrade stop --name alpha
```

## Machine-managed service

For auto-restart on crash/reboot, point `systemd`/`launchd` at
`mm copytrade start … --foreground` and let the supervisor own the process
instead of `--daemon`.
