import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentCard, SendMessageRequest } from "@a2a-js/sdk";
import { Role, TaskState } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import { QueueingAgentExecutor } from "../src/queueing-executor.js";
import { installStableTaskIds } from "../src/stable-task-id.js";
import { GatewayTelemetry } from "../src/telemetry.js";
import { silentLogger } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function request(messageId: string, contextId: string): SendMessageRequest {
  return {
    tenant: "",
    message: {
      messageId,
      contextId,
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: "text", value: "perform one side effect" },
        metadata: undefined,
        filename: "",
        mediaType: "",
      }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: undefined,
  };
}

const agentCard = {
  name: "stream-regression",
  description: "test",
  supportedInterfaces: [],
  provider: undefined,
  version: "1.0.0",
  capabilities: { streaming: true },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
  signatures: [],
} as AgentCard;

describe("message/stream lifecycle and idempotency", () => {
  it("starts with Task, ends terminal, and executes a retry only once", async () => {
    installStableTaskIds(DefaultRequestHandler);
    const gate = deferred();
    let runs = 0;
    let sideEffects = 0;
    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        runs += 1;
        sideEffects += 1;
        await gate.promise;
        eventBus.publish(AgentEvent.statusUpdate({
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          metadata: undefined,
        }));
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };
    const queue = new QueueingAgentExecutor(
      delegate,
      new GatewayTelemetry(silentLogger(), { structuredLogs: false }),
      { maxConcurrentTasks: 1, maxQueuedTasks: 2 },
    );
    const store = new InMemoryTaskStore();
    const handler = new DefaultRequestHandler(agentCard, store, queue);
    const context = new ServerCallContext({ requestedVersion: "1.0", tenant: "tenant-1" });

    const owner = handler.sendMessageStream(request("same-message", "ctx-1"), context);
    const initial = await owner.next();
    assert.equal(initial.value?.payload?.$case, "task");
    if (initial.value?.payload?.$case === "task") {
      assert.equal(initial.value.payload.value.id, "same-message");
      assert.equal(initial.value.payload.value.status.state, TaskState.TASK_STATE_WORKING);
    }

    const retry = handler.sendMessageStream(request("same-message", "ctx-1"), context);
    const snapshot = await retry.next();
    assert.equal(snapshot.value?.payload?.$case, "task");
    assert.equal((await retry.next()).done, true);
    assert.equal(runs, 1);
    assert.equal(sideEffects, 1);

    gate.resolve();
    const remaining = [];
    for await (const event of owner) remaining.push(event);
    assert.ok(remaining.some(
      (event) =>
        event.payload?.$case === "statusUpdate" &&
        event.payload.value.status.state === TaskState.TASK_STATE_COMPLETED,
    ));
    const restartedHandler = new DefaultRequestHandler(agentCard, store, queue);
    const completedRetry = restartedHandler.sendMessageStream(
      request("same-message", "ctx-1"),
      context,
    );
    const persisted = await completedRetry.next();
    assert.equal(persisted.value?.payload?.$case, "task");
    if (persisted.value?.payload?.$case === "task") {
      assert.equal(persisted.value.payload.value.status.state, TaskState.TASK_STATE_COMPLETED);
    }
    assert.equal((await completedRetry.next()).done, true);
    assert.equal(runs, 1);
    assert.equal(sideEffects, 1, "side-effect tool equivalent must run exactly once");
  });

  it("keeps message/send working", async () => {
    installStableTaskIds(DefaultRequestHandler);
    const delegate: AgentExecutor = {
      async execute(requestContext, eventBus) {
        eventBus.publish(AgentEvent.statusUpdate({
          taskId: requestContext.taskId,
          contextId: requestContext.contextId,
          status: {
            state: TaskState.TASK_STATE_COMPLETED,
            timestamp: new Date().toISOString(),
            message: undefined,
          },
          metadata: undefined,
        }));
        eventBus.finished();
      },
      async cancelTask(_taskId, eventBus) {
        eventBus.finished();
      },
    };
    const queue = new QueueingAgentExecutor(
      delegate,
      new GatewayTelemetry(silentLogger(), { structuredLogs: false }),
      { maxConcurrentTasks: 1, maxQueuedTasks: 1 },
    );
    const handler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), queue);
    const result = await handler.sendMessage(
      request("send-message", "ctx-send"),
      new ServerCallContext({ requestedVersion: "1.0" }),
    );
    assert.ok("status" in result);
    if ("status" in result) {
      assert.equal(result.status.state, TaskState.TASK_STATE_COMPLETED);
    }
  });
});
