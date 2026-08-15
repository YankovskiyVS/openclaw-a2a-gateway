import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { installStableTaskIds } from "../src/stable-task-id.js";

describe("installStableTaskIds", () => {
  it("assigns messageId as taskId and pre-seeds missing tasks", async () => {
    const saved: unknown[] = [];
    const store = {
      async load(id: string) {
        return saved.find((task: any) => task.id === id);
      },
      async save(task: unknown) {
        saved.push(task);
      },
    };

    class FakeHandler {
      taskStore = store;
      async _createRequestContext(request: any) {
        return {
          taskId: request.message.taskId,
          messageId: request.message.messageId,
        };
      }
    }

    assert.equal(installStableTaskIds(FakeHandler as any), true);

    const handler = new FakeHandler();
    const result = await (handler as any)._createRequestContext({
      message: { messageId: "user-msg-1", contextId: "chat-1" },
    });

    assert.equal(result.taskId, "user-msg-1");
    assert.equal((saved[0] as any).id, "user-msg-1");
    assert.ok((saved[0] as any).status?.state);
  });

  it("deduplicates concurrent, completed, and persisted retries by messageId", async () => {
    const saved: any[] = [];
    const store = {
      async load(id: string) {
        return saved.find((task) => task.id === id);
      },
      async save(task: any) {
        const index = saved.findIndex((item) => item.id === task.id);
        if (index === -1) saved.push(task);
        else saved[index] = task;
      },
    };

    class FakeHandler {
      taskStore = store;
      sendCalls = 0;

      async _createRequestContext(request: any) {
        return { taskId: request.message.taskId };
      }

      async sendMessage(request: any, context: unknown) {
        this.sendCalls += 1;
        const requestContext = await (this as any)._createRequestContext(request, context);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const task = {
          id: requestContext.taskId,
          status: { state: 2 },
          history: [{ messageId: request.message.messageId }],
        };
        await store.save(task);
        return task;
      }
    }

    assert.equal(installStableTaskIds(FakeHandler as any), true);
    const request = { message: { messageId: "retry-msg-1", contextId: "ctx-1" } };
    const handler = new FakeHandler();

    const [first, concurrentRetry] = await Promise.all([
      (handler as any).sendMessage(request, {}),
      (handler as any).sendMessage(request, {}),
    ]);
    await store.save({ ...first as any, status: { state: 3 } });
    const completedRetry = await (handler as any).sendMessage(request, {});

    assert.equal(handler.sendCalls, 1);
    assert.equal((first as any).id, "retry-msg-1");
    assert.deepEqual(concurrentRetry, first);
    assert.equal((completedRetry as any).status.state, 3, "retry should return the latest stored task");

    const restartedHandler = new FakeHandler();
    const persistedRetry = await (restartedHandler as any).sendMessage(
      { message: { messageId: "retry-msg-1", contextId: "ctx-1" } },
      {},
    );
    assert.equal(restartedHandler.sendCalls, 0);
    assert.equal((persistedRetry as any).id, "retry-msg-1");
    assert.equal((persistedRetry as any).status.state, 3);
  });
  it("deduplicates running and completed message/stream requests", async () => {
    const saved: any[] = [];
    const store = {
      async load(id: string) {
        return saved.find((task) => task.id === id);
      },
      async save(task: any) {
        const index = saved.findIndex((item) => item.id === task.id);
        if (index === -1) saved.push(task);
        else saved[index] = task;
      },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    class FakeStreamingHandler {
      taskStore = store;
      streamCalls = 0;
      sideEffectCalls = 0;

      async _createRequestContext(request: any) {
        return { taskId: request.message.taskId };
      }

      async *sendMessageStream(request: any, context: unknown) {
        this.streamCalls += 1;
        this.sideEffectCalls += 1;
        const requestContext = await (this as any)._createRequestContext(request, context);
        const working = {
          kind: "task",
          id: requestContext.taskId,
          contextId: request.message.contextId,
          status: { state: 2 },
          history: [{ messageId: request.message.messageId }],
          artifacts: [],
        };
        await store.save(working);
        yield { payload: { $case: "task", value: working } };

        await gate;
        const completed = { ...working, status: { state: 3 } };
        await store.save(completed);
        yield {
          payload: {
            $case: "statusUpdate",
            value: {
              taskId: completed.id,
              contextId: completed.contextId,
              status: completed.status,
            },
          },
        };
      }
    }

    assert.equal(installStableTaskIds(FakeStreamingHandler as any), true);
    const handler = new FakeStreamingHandler();
    const firstRequest = {
      message: { messageId: "stream-msg-1", contextId: "ctx-stream" },
    };
    const owner = (handler as any).sendMessageStream(firstRequest, {});
    const initial = await owner.next();

    assert.equal(initial.value.payload.$case, "task");
    assert.equal(initial.value.payload.value.id, "stream-msg-1");

    const retry = (handler as any).sendMessageStream(
      { message: { messageId: "stream-msg-1", contextId: "ctx-stream" } },
      {},
    );
    const retrySnapshot = await retry.next();
    const retryDone = await retry.next();

    assert.equal(retrySnapshot.value.payload.$case, "task");
    assert.equal(retrySnapshot.value.payload.value.status.state, 2);
    assert.equal(retryDone.done, true);
    assert.equal(handler.streamCalls, 1);
    assert.equal(handler.sideEffectCalls, 1, "side effect must execute exactly once");

    release();
    const terminal = await owner.next();
    const ownerDone = await owner.next();
    assert.equal(terminal.value.payload.$case, "statusUpdate");
    assert.equal(terminal.value.payload.value.status.state, 3);
    assert.equal(ownerDone.done, true);

    const restartedHandler = new FakeStreamingHandler();
    const completedRetry = (restartedHandler as any).sendMessageStream(
      { message: { messageId: "stream-msg-1", contextId: "ctx-stream" } },
      {},
    );
    const persisted = await completedRetry.next();
    assert.equal(persisted.value.payload.$case, "task");
    assert.equal(persisted.value.payload.value.status.state, 3);
    assert.equal(restartedHandler.streamCalls, 0);
    assert.equal(restartedHandler.sideEffectCalls, 0);
  });


});
