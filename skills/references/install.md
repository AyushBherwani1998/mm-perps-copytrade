# Install & Enable

The `perps-copytrade` plugin extends the `mm` CLI with the `copytrade` command
topic. It requires `@metamask/agent-wallet` v6+ installed and initialized.

## 1. Enable experimental plugins

Plugins are beta and off by default:

```bash
mm config get                              # check experimentalPlugins
mm config set experimentalPlugins true
```

## 2. Install the plugin

From the npm registry:

```bash
mm plugins install perps-copytrade
```

Pin a version with `perps-copytrade@<version>` if needed. The plugin declares
the `wallet-read` capability (its `copytrade:start` command reads accounts); the
CLI shows a consent prompt before installing, defaulting to No. In a non-TTY
session, or when passing `--json`, add `--accept-permissions`.

### Local development install

During local development, install from a packed tarball rather than the source
directory. A directory/`file:`-symlink install may complete at the npm layer but
fail to register with the mm plugin layer, so the `copytrade` commands never
appear. Packing to a tarball installs a real package and persists the
capability approval:

```bash
cd /path/to/perps-copytrade
npm run build                              # tsc + oclif manifest
npm pack --pack-destination /tmp          # -> /tmp/perps-copytrade-<ver>.tgz
cd /path/to/agentic-cli/packages/agentic-cli
mm plugins install file:/tmp/perps-copytrade-0.1.0.tgz --accept-permissions
```

`--accept-permissions` is required for non-TTY installs and acknowledges that the
plugin runs the publisher's code with the CLI's privileges. Signing still routes
through MetaMask policy (MFA-gated).

## 3. Verify registration

```bash
mm plugins inspect perps-copytrade        # lists copytrade:start/stop/status/logs
mm copytrade status --help                # resolves once registered
```

If `mm copytrade …` reports "Command not found" or `mm plugins inspect` says
"not installed" even though the install command reported success, the plugin was
not registered — reinstall from the tarball as above.

## Reinstalling after code changes

An installed tarball is a snapshot. After editing and rebuilding the plugin,
re-pack and reinstall the tarball to pick up the changes, then re-verify the
command help.

## Commands

| Command | Description |
| --- | --- |
| `mm plugins install <spec> [--accept-permissions]` | Install/enable the plugin |
| `mm plugins inspect perps-copytrade` | Show the plugin's commands and deps |
| `mm plugins uninstall perps-copytrade` | Remove the plugin |
