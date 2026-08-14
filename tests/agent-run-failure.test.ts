import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { agentRunFailureMessage } from "../src/agent-run-failure.js";

describe("agentRunFailureMessage", () => {
  it("returns undefined for ok status", () => {
    assert.equal(agentRunFailureMessage({ status: "ok" }), undefined);
  });

  it("maps timeout status", () => {
    assert.equal(
      agentRunFailureMessage({ status: "timeout", error: "model timed out" }),
      "model timed out",
    );
    assert.equal(agentRunFailureMessage({ status: "timeout" }), "Agent run timed out");
  });

  it("maps error status", () => {
    assert.equal(
      agentRunFailureMessage({ status: "error", error: "provider down" }),
      "provider down",
    );
  });

  it("maps nested result status", () => {
    assert.equal(
      agentRunFailureMessage({ result: { status: "timeout", error: "outer wait" } }),
      "outer wait",
    );
  });

  it("maps surface_error text even when status is ok", () => {
    assert.equal(
      agentRunFailureMessage({
        status: "ok",
        error: "surface_error: timeout from cloudru/Qwen",
      }),
      "surface_error: timeout from cloudru/Qwen",
    );
  });
});
