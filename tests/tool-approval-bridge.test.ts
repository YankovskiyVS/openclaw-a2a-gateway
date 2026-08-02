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

  it("finds stream when OpenClaw sessionKey has session: prefix and foreign runId", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-5",
      contextId: "ctx-5",
      runId: "a2a-run-5",
      sessionKey: "agent:main:a2a:ctx-5",
    });

    const wait = bridge.requestApproval({
      toolName: "write",
      params: { path: "x" },
      toolCallId: "call-5",
      runId: "chatcmpl_foreign",
      sessionKey: "session:agent:main:a2a:ctx-5",
      timeoutMs: 5_000,
    });

    assert.equal(bridge.isAwaitingApproval("task-5"), true);
    assert.ok(bus.events.length >= 2, "expected pending_approval published to A2A bus");
    bridge.resolve("x", "allow-once", "call-5");
    assert.equal(await wait, "allow-once");
    bridge.unregisterStream("a2a-run-5");
  });

  it("dedupes duplicate before_tool_call for the same callId", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-6",
      contextId: "ctx-6",
      runId: "run-6",
      sessionKey: "agent:main:a2a:ctx-6",
    });

    const params = {
      toolName: "exec",
      params: { command: "ls" },
      toolCallId: "call-6",
      sessionKey: "agent:main:a2a:ctx-6",
      timeoutMs: 5_000,
    } as const;
    const first = bridge.requestApproval(params);
    const second = bridge.requestApproval(params);
    // Only one pending_approval artifact pair for the shared wait.
    assert.equal(bus.events.length, 2);
    bridge.resolve("x", "allow-once", "call-6");
    assert.deepEqual(await Promise.all([first, second]), ["allow-once", "allow-once"]);
    bridge.unregisterStream("run-6");
  });

  it("allow-always still publishes running on the A2A bus", async () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    const sessionKey = "agent:main:a2a:ctx-7";
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-7",
      contextId: "ctx-7",
      runId: "run-7",
      sessionKey,
    });

    const first = bridge.requestApproval({
      toolName: "write",
      params: { path: "a" },
      toolCallId: "call-7a",
      sessionKey,
      timeoutMs: 5_000,
    });
    bridge.resolve("x", "allow-always", "call-7a");
    assert.equal(await first, "allow-always");
    bus.events.length = 0;

    const second = await bridge.requestApproval({
      toolName: "write",
      params: { path: "b" },
      toolCallId: "call-7b",
      sessionKey,
      timeoutMs: 5_000,
    });
    assert.equal(second, "allow-always");
    assert.ok(bus.events.length >= 1, "expected running artifact for allow-always shortcut");
    bridge.unregisterStream("run-7");
  });

  it("publishToolResult emits completed status on the A2A bus", () => {
    const bridge = new ToolApprovalBridge();
    const bus = mockEventBus();
    bridge.registerStream({
      eventBus: bus as never,
      taskId: "task-8",
      contextId: "ctx-8",
      runId: "run-8",
      sessionKey: "agent:main:a2a:ctx-8",
    });

    const published = bridge.publishToolResult({
      toolName: "exec",
      toolCallId: "call-8",
      runId: "run-8",
      sessionKey: "agent:main:a2a:ctx-8",
      result: { stdout: "ok" },
    });
    assert.equal(published, true);
    assert.equal(bus.events.length, 1);
    const raw = JSON.stringify(bus.events[0]);
    assert.match(raw, /"status":"completed"/);
    assert.match(raw, /"phase":"result"/);
    assert.match(raw, /"callId":"call-8"/);
    bridge.unregisterStream("run-8");
  });
});
