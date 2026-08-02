import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractInterruptSignal, isInterruptOnlyMessage } from "../src/interrupt.js";
import { ActiveRunRegistry, RunCanceledError, isAbortError } from "../src/active-runs.js";
import { TaskState } from "@a2a-js/sdk";

describe("interrupt metadata", () => {
  it("extracts metadata.interrupt", () => {
    const signal = extractInterruptSignal({
      parts: [{ text: "" }],
      metadata: {
        interrupt: { reason: "user_stop", taskId: "task-1", runId: "run-1" },
      },
    });
    assert.deepEqual(signal, {
      reason: "user_stop",
      taskId: "task-1",
      runId: "run-1",
    });
  });

  it("treats metadata.abort=true as interrupt", () => {
    const signal = extractInterruptSignal({
      parts: [{ text: "" }],
      metadata: { abort: true },
    });
    assert.equal(signal?.reason, "abort");
  });

  it("isInterruptOnlyMessage requires empty text", () => {
    assert.equal(
      isInterruptOnlyMessage({
        parts: [{ text: "" }],
        metadata: { interrupt: { reason: "stop" } },
      }),
      true,
    );
    assert.equal(
      isInterruptOnlyMessage({
        parts: [{ text: "please stop" }],
        metadata: { interrupt: { reason: "stop" } },
      }),
      false,
    );
  });
});

describe("ActiveRunRegistry", () => {
  it("interrupts active run and publishes canceled status", async () => {
    const events: unknown[] = [];
    const bus = {
      publish(event: unknown) {
        events.push(event);
      },
      finished() {
        events.push({ kind: "finished" });
      },
    };
    const registry = new ActiveRunRegistry();
    const abortController = new AbortController();
    let closed = false;
    registry.register({
      taskId: "task-1",
      contextId: "ctx-1",
      sessionKey: "agent:main:a2a:ctx-1",
      runId: "run-1",
      eventBus: bus as never,
      abortController,
      closeGateway: () => {
        closed = true;
      },
      canceled: false,
      finished: false,
    });

    const found = registry.find({ contextId: "ctx-1" });
    assert.ok(found);
    await registry.interrupt(found, "Stopped by user");

    assert.equal(abortController.signal.aborted, true);
    assert.equal(closed, true);
    assert.equal(found.canceled, true);
    assert.equal(found.finished, true);
    // Still registered so owning execute() can observe canceled/finished.
    assert.equal(registry.getByTaskId("task-1"), found);
    assert.ok(
      events.some((event) => {
        const status = (event as { data?: { status?: { state?: TaskState } } })?.data?.status?.state;
        return status === TaskState.TASK_STATE_CANCELED;
      }),
      `expected CANCELED status, got ${JSON.stringify(events)}`,
    );
    registry.unregister("task-1");
    assert.equal(registry.getByTaskId("task-1"), undefined);
  });

  it("findAll returns every active run for a context", () => {
    const registry = new ActiveRunRegistry();
    const bus = {
      publish() {},
      finished() {},
    };
    for (const taskId of ["task-a", "task-b"]) {
      registry.register({
        taskId,
        contextId: "ctx-multi",
        sessionKey: "agent:main:a2a:ctx-multi",
        runId: `run-${taskId}`,
        eventBus: bus as never,
        abortController: new AbortController(),
        canceled: false,
        finished: false,
      });
    }
    const found = registry.findAll({ contextId: "ctx-multi" });
    assert.equal(found.length, 2);
    assert.deepEqual(found.map((run) => run.taskId).sort(), ["task-a", "task-b"]);
  });

  it("detects abort errors", () => {
    assert.equal(isAbortError(new RunCanceledError()), true);
    assert.equal(isAbortError(new Error("Request aborted")), true);
    assert.equal(isAbortError(new Error("boom")), false);
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    assert.equal(isAbortError(timeout), false);
  });
});
