import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { Task } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus } from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";

import { QueueingAgentExecutor } from "../src/queueing-executor.js";
import { FileTaskStore, MemoryTaskStore } from "../src/task-store.js";
import { GatewayTelemetry } from "../src/telemetry.js";

import { executionTaskState, partTextFromJson, silentLogger } from "./helpers.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createEventBus() {
  const events: unknown[] = [];
  let finished = false;

  const bus: ExecutionEventBus = {
    publish(event) {
      events.push(event);
    },
    on() {
      return bus;
    },
    off() {
      return bus;
    },
    once() {
      return bus;
    },
    removeAllListeners() {
      return bus;
    },
    finished() {
      finished = true;
    },
  };

  return {
    bus,
    events,
    isFinished: () => finished,
  };
}

function makeTask(taskId: string, contextId = `ctx-${taskId}`): Task {
  return {
    id: taskId,
    contextId,
    status: {
      state: TaskState.TASK_STATE_COMPLETED,
      timestamp: new Date().toISOString(),
      message: undefined,
    },
    artifacts: [
      {
        artifactId: `artifact-${taskId}`,
        name: "",
        description: "",
        parts: [{ content: { $case: "text", value: `done-${taskId}` }, metadata: undefined, filename: "", mediaType: "" }],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [],
    metadata: undefined,
  };
}

function makeRequestContext(taskId: string, contextId = `ctx-${taskId}`) {
  return {
    taskId,
    contextId,
    userMessage: {
      messageId: `msg-${taskId}`,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "text", value: `hello-${taskId}` }, metadata: undefined, filename: "", mediaType: "" }],
      contextId,
      taskId,
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
  } as any;
}

describe("P0 runtime components", () => {
  it("FileTaskStore persists tasks across instances", async () => {
    const tasksDir = await mkdtemp(path.join(os.tmpdir(), "a2a-gateway-task-store-"));

    try {
      const writer = new FileTaskStore(tasksDir);
      await writer.save(makeTask("task-1"));

      const reader = new FileTaskStore(tasksDir);
      const restored = await reader.load("task-1");

      assert.ok(restored, "task should be restored from disk");
      assert.equal(restored.id, "task-1");
      assert.equal(partTextFromJson(restored.artifacts?.[0]?.parts?.[0] as Record<string, unknown>), `done-task-1`);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("MemoryTaskStore is volatile but preserves TaskStore semantics within one process", async () => {
    const store = new MemoryTaskStore();
    await store.save(makeTask("memory-task"));
    const loaded = await store.load("memory-task");
    assert.equal(store.mode, "memory");
    assert.equal(loaded?.id, "memory-task");
    assert.deepEqual(await store.listAll(), ["memory-task"]);
    assert.equal(await store.delete("memory-task"), true);
    assert.equal(await store.load("memory-task"), undefined);
    assert.equal(await new MemoryTaskStore().load("memory-task"), undefined);
  });

  it("reports volatile memory mode in operator telemetry", () => {
    const telemetry = new GatewayTelemetry(silentLogger(), {
      structuredLogs: false,
      storageMode: "memory",
      metricsEndpointEnabled: false,
    });
    telemetry.setApprovalStateProvider(() => ({
      activeStreams: 2,
      pendingApprovals: 3,
      reservedActions: 4,
    }));
    const runtime = telemetry.snapshot().runtime;
    assert.equal(runtime.storage_mode, "memory");
    assert.equal(runtime.persistence_enabled, false);
    assert.equal(runtime.multi_replica_safe, false);
    assert.equal(runtime.metrics_endpoint_enabled, false);
    assert.equal(runtime.active_approval_streams, 2);
    assert.equal(runtime.pending_approvals, 3);
    assert.equal(runtime.reserved_actions, 4);
  });

  it("QueueingAgentExecutor queues overflow within the same session", async () => {
    const telemetry = new GatewayTelemetry(silentLogger(), { structuredLogs: false });

    const gates = new Map<string, ReturnType<typeof createDeferred>>();
    gates.set("task-1", createDeferred());
    gates.set("task-2", createDeferred());

    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        await gates.get(requestContext.taskId)?.promise;
        eventBus.publish(AgentEvent.task(makeTask(requestContext.taskId)));
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };

    const executor = new QueueingAgentExecutor(delegate, telemetry, {
      maxConcurrentTasks: 1,
      maxQueuedTasks: 1,
    });

    const bus1 = createEventBus();
    const bus2 = createEventBus();
    const bus3 = createEventBus();
    const sameSession = "ctx-shared";

    const p1 = executor.execute(makeRequestContext("task-1", sameSession), bus1.bus);
    const p2 = executor.execute(makeRequestContext("task-2", sameSession), bus2.bus);
    const p3 = executor.execute(makeRequestContext("task-3", sameSession), bus3.bus);

    await Promise.resolve();

    assert.equal((bus1.events[0] as { kind?: string }).kind, "task");
    assert.equal(executionTaskState(bus1.events[0]), TaskState.TASK_STATE_WORKING);
    assert.equal(executionTaskState(bus2.events[0]), TaskState.TASK_STATE_SUBMITTED);
    assert.equal(executionTaskState(bus3.events[0]), TaskState.TASK_STATE_REJECTED);
    assert.equal(bus3.isFinished(), true);

    gates.get("task-1")?.resolve();
    await p1;

    await new Promise((resolve) => setTimeout(resolve, 0));
    gates.get("task-2")?.resolve();
    await p2;
    await p3;

    assert.equal(executionTaskState(bus1.events.at(-1)), TaskState.TASK_STATE_COMPLETED);
    assert.equal(executionTaskState(bus2.events.at(-1)), TaskState.TASK_STATE_COMPLETED);

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.tasks.started, 2);
    assert.equal(snapshot.tasks.completed, 2);
    assert.equal(snapshot.tasks.queue_rejections, 1);
    assert.equal(snapshot.tasks.rejected, 1);
    assert.equal(snapshot.tasks.queued, 1);
  });
  it("QueueingAgentExecutor does not run duplicate queued or running taskIds", async () => {
    const telemetry = new GatewayTelemetry(silentLogger(), { structuredLogs: false });
    const busyGate = createDeferred();
    const queuedGate = createDeferred();
    const calls = new Map<string, number>();

    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        calls.set(requestContext.taskId, (calls.get(requestContext.taskId) ?? 0) + 1);
        if (requestContext.taskId === "task-busy") {
          await busyGate.promise;
        } else {
          await queuedGate.promise;
        }
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: requestContext.taskId,
            contextId: requestContext.contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              timestamp: new Date().toISOString(),
              message: undefined,
            },
            metadata: undefined,
          }),
        );
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };

    const executor = new QueueingAgentExecutor(delegate, telemetry, {
      maxConcurrentTasks: 1,
      maxQueuedTasks: 2,
    });
    const session = "ctx-dedup";
    const busyBus = createEventBus();
    const ownerBus = createEventBus();
    const duplicateBus = createEventBus();

    const busy = executor.execute(makeRequestContext("task-busy", session), busyBus.bus);
    const owner = executor.execute(makeRequestContext("task-same", session), ownerBus.bus);
    const duplicate = executor.execute(
      makeRequestContext("task-same", session),
      duplicateBus.bus,
    );

    assert.equal(owner, duplicate, "duplicate must join the owner's completion");
    assert.equal((ownerBus.events[0] as { kind?: string }).kind, "task");
    assert.equal(executionTaskState(ownerBus.events[0]), TaskState.TASK_STATE_SUBMITTED);
    assert.equal(duplicateBus.events.length, 0, "duplicate must not publish on a second bus");

    busyGate.resolve();
    await busy;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.get("task-same"), 1);

    queuedGate.resolve();
    await Promise.all([owner, duplicate]);
    assert.equal(calls.get("task-same"), 1, "underlying agent must execute once");
    assert.equal(
      executionTaskState(ownerBus.events.at(-1)),
      TaskState.TASK_STATE_COMPLETED,
    );
  });


  it("QueueingAgentExecutor runs different sessions in parallel", async () => {
    const telemetry = new GatewayTelemetry(silentLogger(), { structuredLogs: false });
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof createDeferred>>();
    gates.set("task-a", createDeferred());
    gates.set("task-b", createDeferred());

    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        started.push(requestContext.taskId);
        await gates.get(requestContext.taskId)?.promise;
        eventBus.publish(AgentEvent.task(makeTask(requestContext.taskId)));
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };

    const executor = new QueueingAgentExecutor(delegate, telemetry, {
      maxConcurrentTasks: 1,
      maxQueuedTasks: 0,
    });

    const busA = createEventBus();
    const busB = createEventBus();

    const pA = executor.execute(makeRequestContext("task-a", "ctx-a"), busA.bus);
    const pB = executor.execute(makeRequestContext("task-b", "ctx-b"), busB.bus);

    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both sessions start immediately despite maxConcurrentTasks=1 (per-session).
    assert.deepEqual(started.sort(), ["task-a", "task-b"]);

    gates.get("task-a")?.resolve();
    gates.get("task-b")?.resolve();
    await Promise.all([pA, pB]);

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.tasks.started, 2);
    assert.equal(snapshot.tasks.completed, 2);
    assert.equal(snapshot.tasks.queue_rejections, 0);
  });

  it("QueueingAgentExecutor bypasses concurrency for interrupt-only messages", async () => {
    const telemetry = new GatewayTelemetry(silentLogger(), { structuredLogs: false });
    const started: string[] = [];
    const gate = createDeferred();

    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        started.push(requestContext.taskId);
        if (requestContext.taskId === "task-busy") {
          await gate.promise;
        }
        eventBus.publish(AgentEvent.task(makeTask(requestContext.taskId)));
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };

    const executor = new QueueingAgentExecutor(delegate, telemetry, {
      maxConcurrentTasks: 1,
      maxQueuedTasks: 0,
    });

    const busBusy = createEventBus();
    const busInterrupt = createEventBus();
    const session = "ctx-interrupt-bypass";

    const pBusy = executor.execute(makeRequestContext("task-busy", session), busBusy.bus);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(started, ["task-busy"]);

    const interruptContext = makeRequestContext("task-interrupt", session);
    interruptContext.userMessage = {
      messageId: "msg-interrupt",
      role: "ROLE_USER",
      parts: [{ text: "" }],
      metadata: { interrupt: { reason: "user_stop" } },
    } as never;

    const pInterrupt = executor.execute(interruptContext, busInterrupt.bus);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(started.includes("task-interrupt"), "interrupt must not wait behind busy turn");

    gate.resolve();
    await Promise.all([pBusy, pInterrupt]);
  });
});
