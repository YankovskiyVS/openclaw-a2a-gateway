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
});
