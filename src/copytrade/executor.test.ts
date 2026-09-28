import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractError, parseJsonBlock } from "./executor.js";

describe("parseJsonBlock", () => {
  it("parses the host's pretty-printed multi-line payload", () => {
    // A per-line parse only ever sees a bare `{` here — the original bug.
    const out = `{
  "ok": true,
  "data": {
    "venue": "hyperliquid",
    "symbol": "BTC",
    "orderId": "548614895837",
    "status": "filled"
  }
}`;
    const parsed = parseJsonBlock(out);
    assert.equal(parsed?.ok, true);
    assert.equal((parsed?.data as Record<string, unknown>).orderId, "548614895837");
  });

  it("ignores Node's deprecation noise around the payload", () => {
    const out = `(node:123) [DEP0040] DeprecationWarning: The \`punycode\` module is deprecated.
{
  "ok": false,
  "error": { "code": "INSUFFICIENT_MARGIN", "message": "not enough free margin" }
}
(Use \`node --trace-deprecation ...\` to show where the warning was created)`;
    const parsed = parseJsonBlock(out);
    assert.equal(parsed?.ok, false);
  });

  it("is not confused by braces inside strings", () => {
    const parsed = parseJsonBlock('{ "message": "unexpected } brace {" }');
    assert.equal(parsed?.message, "unexpected } brace {");
  });

  it("returns undefined when there is no JSON at all", () => {
    assert.equal(parseJsonBlock("command not found"), undefined);
    assert.equal(parseJsonBlock(""), undefined);
  });
});

describe("extractError", () => {
  it("surfaces the host's structured code and message", () => {
    const parsed = parseJsonBlock(`{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_MARGIN",
    "message": "Insufficient free margin to open this position",
    "hint": "Free up margin"
  }
}`);
    assert.equal(
      extractError(parsed, "", 1),
      "INSUFFICIENT_MARGIN: Insufficient free margin to open this position"
    );
  });

  it("never reports a bare brace as the reason", () => {
    // The incident's stderr: pretty-printed JSON whose first line is just `{`.
    const stderr = `{
  "ok": false,
  "error": { "code": "ORDER_REJECTED", "message": "order rejected by venue" }
}`;
    const reason = extractError(parseJsonBlock(stderr), stderr, 1);
    assert.notEqual(reason, "{");
    assert.equal(reason, "ORDER_REJECTED: order rejected by venue");
  });

  it("falls back to a meaningful stderr line, skipping braces and warnings", () => {
    const stderr = `(node:1) [DEP0040] DeprecationWarning: punycode is deprecated
{
Error: socket hang up`;
    assert.equal(extractError(undefined, stderr, 1), "Error: socket hang up");
  });

  it("falls back to the exit code when nothing else is available", () => {
    assert.equal(extractError(undefined, "", 7), "exit code 7");
    assert.equal(extractError(undefined, "{\n}", null), "exit code null");
  });
});
