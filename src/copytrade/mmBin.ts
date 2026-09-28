/**
 * Resolve how to launch the `mm` CLI from within a running `mm` process.
 *
 * Defaults to re-running the same entrypoint that loaded this plugin
 * (`node <mm-entry>`), guaranteeing version parity. An `MM_BIN` override lets
 * tests or non-standard installs point elsewhere.
 */
export function resolveMmBin(): { cmd: string; pre: string[] } {
  const override = process.env.MM_BIN;
  if (override) return { cmd: override, pre: [] };
  const entry = process.argv[1];
  if (entry) return { cmd: process.execPath, pre: [entry] };
  return { cmd: "mm", pre: [] };
}
