import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractTextParts,
  isMessage,
  isTask,
  normalizeTaskState,
  taskResponseText,
  textPart,
} from "../skill/scripts/a2a-proto.mjs";

describe("A2A CLI SDK 1.0.1 protobuf compatibility", () => {
  it("encodes text as a protobuf Part instead of the removed kind/text shape", () => {
    assert.deepEqual(textPart("hello"), {
      content: { $case: "text", value: "hello" },
      metadata: undefined,
      filename: "",
      mediaType: "",
    });
  });

  it("extracts and joins streamed protobuf text chunks", () => {
    assert.equal(extractTextParts([textPart("long "), textPart("answer")]), "long answer");
  });

  it("prefers the complete response artifact over a short status message", () => {
    const task = {
      status: { message: { parts: [textPart("short")] } },
      artifacts: [{ parts: [textPart("complete "), textPart("artifact response")] }],
    };
    assert.equal(taskResponseText(task), "complete artifact response");
  });

  it("normalizes numeric SDK task states used by polling", () => {
    assert.equal(normalizeTaskState(1), "submitted");
    assert.equal(normalizeTaskState(2), "working");
    assert.equal(normalizeTaskState(3), "completed");
    assert.equal(normalizeTaskState(4), "failed");
    assert.equal(normalizeTaskState("TASK_STATE_AUTH_REQUIRED"), "auth-required");
  });

  it("recognizes SDK 1.0.1 Message and Task results without legacy kind fields", () => {
    assert.equal(isMessage({ messageId: "m1", parts: [textPart("ok")] }), true);
    assert.equal(isTask({ id: "t1", status: { state: 2 } }), true);
  });
});
