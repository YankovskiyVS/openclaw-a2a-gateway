import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toolStatusFromPhase } from "../src/tool-approval.js";

describe("toolStatusFromPhase", () => {
  it("maps result/error to terminal status even when approval is disabled", () => {
    assert.equal(toolStatusFromPhase("result", false, false), "completed");
    assert.equal(toolStatusFromPhase("result", false, true), "failed");
    assert.equal(toolStatusFromPhase("error", false, false), "failed");
  });

  it("maps start/update to running only when approval is enabled", () => {
    assert.equal(toolStatusFromPhase("start", true), "running");
    assert.equal(toolStatusFromPhase("update", true), "running");
    assert.equal(toolStatusFromPhase("start", false), undefined);
  });
});
