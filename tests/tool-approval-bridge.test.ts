import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ToolApprovalBridge } from "../src/tool-approval-bridge.js";

function mockEventBus() {
  const events: unknown[] = [];
  return {
    events,
    publish(event: unknown) {
      events.push(event);
    },
    finished() {},
  };
}

describe("ToolApprovalBridge", () => {
  it("pauses until resolve(allow-once) and publishes A2A events with approvalId", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
      runId: "run-1",
      sessionKey: "agent:default:a2a:ctx-1",
    });

    const wait = bridge.requestApproval({
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-1",
      runId: "run-1",
      sessionKey: "agent:default:a2a:ctx-1",
      timeoutMs: 5_000,
    });

    assert.equal(bridge.isAwaitingApproval("task-1"), true);
    assert.ok(bus.events.length >= 2, `expected artifact + status events, got ${bus.events.length}`);

    const settled = bridge.resolve("unknown-approval-id", "allow-once", "call-1");
    assert.equal(settled, true);

    const decision = await wait;
    assert.equal(decision, "allow-once");
    assert.equal(bridge.isAwaitingApproval("task-1"), false);

    bridge.unregisterStream("run-1");
  });

  it("blocks with deny when resolve(deny)", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-2",
      contextId: "ctx-2",
      runId: "run-2",
      sessionKey: "agent:default:a2a:ctx-2",
    });

    const wait = bridge.requestApproval({
      toolName: "exec",
      params: { command: "rm -rf /" },
      toolCallId: "call-2",
      sessionKey: "agent:default:a2a:ctx-2",
      timeoutMs: 5_000,
    });

    assert.equal(bridge.resolve("missing-id", "deny", "call-2"), true);
    assert.equal(await wait, "deny");
    bridge.unregisterStream("run-2");
  });

  it("skips tools not in allowlist", async () => {
    const bridge = new ToolApprovalBridge();
    const decision = await bridge.requestApproval({
      toolName: "web_search",
      params: { q: "x" },
      tools: ["exec"],
      timeoutMs: 1000,
    });
    assert.equal(decision, "allow-once");
  });

  it("allow-always remembers tool for session", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    const sessionKey = "agent:default:a2a:ctx-3";
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-3",
      contextId: "ctx-3",
      runId: "run-3",
      sessionKey,
    });

    const first = bridge.requestApproval({
      toolName: "exec",
      params: { command: "echo 1" },
      toolCallId: "c1",
      sessionKey,
      timeoutMs: 5_000,
    });
    bridge.resolve("x", "allow-always", "c1");
    assert.equal(await first, "allow-always");

    const second = await bridge.requestApproval({
      toolName: "exec",
      params: { command: "echo 2" },
      toolCallId: "c2",
      sessionKey,
      timeoutMs: 5_000,
    });
    assert.equal(second, "allow-always");
    bridge.unregisterStream("run-3");
  });

  it("times out when no decision arrives", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-4",
      contextId: "ctx-4",
      runId: "run-4",
      sessionKey: "agent:default:a2a:ctx-4",
    });

    const decision = await bridge.requestApproval({
      toolName: "exec",
      params: { command: "sleep" },
      toolCallId: "call-4",
      sessionKey: "agent:default:a2a:ctx-4",
      timeoutMs: 50,
    });
    assert.equal(decision, "timeout");
    bridge.unregisterStream("run-4");
  });
});
