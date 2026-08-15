import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolApprovalBridge } from "../src/tool-approval-bridge.js";

function eventBus() {
  const events: unknown[] = [];
  return { events, publish(event: unknown) { events.push(event); }, finished() {} };
}

describe("native approval contract", () => {
  it("allows passive tools but fails closed when mutation approval is unavailable", async () => {
    const bridge = new ToolApprovalBridge();
    assert.equal(await bridge.requestApproval({ toolName: "vendor_account_get", params: {}, timeoutMs: 100 }), "unavailable");
    assert.equal(await bridge.requestApproval({
      toolName: "nango_list_connections",
      params: {},
      timeoutMs: 100,
    }), "allow-once");
    assert.equal(await bridge.requestApproval({
      toolName: "nango_yandex_mail_send",
      params: { to: ["user@example.test"], subject: "s", body: "b" },
      timeoutMs: 100,
    }), "unavailable");
  });

  it("binds approval to actionHash and rejects an exact mutation retry", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = eventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "turn-9",
      contextId: "ctx-9",
      runId: "run-9",
      sessionKey: "agent:main:a2a:ctx-9",
    });
    const input = {
      toolName: "nango_yandex_mail_send",
      params: { to: ["user@example.test"], subject: "s", body: "b" },
      sessionKey: "agent:main:a2a:ctx-9",
      timeoutMs: 5_000,
    };
    const first = bridge.requestApproval({ ...input, toolCallId: "mail-1" });
    const raw = JSON.stringify(bus.events);
    assert.match(raw, /"actionHash":"sha256:[0-9a-f]{64}"/);
    assert.match(raw, /"userTurnId":"turn-9"/);
    assert.equal(bridge.resolve("missing", "allow-once", "mail-1", "sha256:bad"), false);
    assert.equal(bridge.resolve("missing", "allow-once", "mail-1"), true);
    assert.equal(await first, "allow-once");

    let executions = 1;
    const retry = await bridge.requestApproval({ ...input, toolCallId: "mail-2" });
    if (retry === "allow-once" || retry === "allow-session" || retry === "allow-always") {
      executions += 1;
    }
    assert.equal(retry, "duplicate");
    assert.equal(executions, 1);
    bridge.unregisterStream("run-9");
  });


  it("reserves Judge-approved mutations in the same exact-action ledger", () => {
    const bridge = new ToolApprovalBridge();
    const bus = eventBus();
    bridge.registerStream({ eventBus: bus as never, taskId: "turn-judge", contextId: "ctx-judge", runId: "run-judge" });
    const input = {
      toolName: "nango_yandex_mail_send",
      params: { to: ["user@example.test"], subject: "s", body: "b" },
      toolCallId: "judge-mail-1",
      runId: "run-judge",
      timeoutMs: 5_000,
    };
    assert.equal(bridge.reserveApprovedAction(input), "allow-once");
    assert.equal(bridge.reserveApprovedAction({ ...input, toolCallId: "judge-mail-2" }), "duplicate");
    bridge.unregisterStream("run-judge");
  });
  it("changing recipient creates a new actionHash and approval", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = eventBus();
    bridge.registerStream({ eventBus: bus as never, taskId: "turn-10", contextId: "ctx-10", runId: "run-10" });
    const first = bridge.requestApproval({ toolName: "nango_yandex_mail_send", params: { to: ["a@test"] }, toolCallId: "m1", runId: "run-10", timeoutMs: 5_000 });
    bridge.resolve("x", "allow-once", "m1");
    await first;
    const second = bridge.requestApproval({ toolName: "nango_yandex_mail_send", params: { to: ["b@test"] }, toolCallId: "m2", runId: "run-10", timeoutMs: 5_000 });
    assert.equal(bridge.resolve("x", "deny", "m2"), true);
    assert.equal(await second, "deny");
    bridge.unregisterStream("run-10");
  });
});
