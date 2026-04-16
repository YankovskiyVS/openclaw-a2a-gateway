import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeAgentNameFromMetadata } from "../index.js";

describe("normalizeAgentNameFromMetadata", () => {
  it("maps JSON-RPC params.metadata.agentName to params.message.agentName", () => {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/stream",
      params: {
        message: {
          kind: "message",
          messageId: "msg-1",
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
        },
        metadata: {
          agentName: "main",
        },
      },
    };

    normalizeAgentNameFromMetadata(body);

    const params = body.params as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    assert.equal(message.agentName, "main");
  });

  it("does not override existing message.agentName", () => {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: "1",
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: "msg-1",
          role: "user",
          agentName: "coder",
          parts: [{ kind: "text", text: "hi" }],
        },
        metadata: {
          agentName: "main",
        },
      },
    };

    normalizeAgentNameFromMetadata(body);

    const params = body.params as Record<string, unknown>;
    const message = params.message as Record<string, unknown>;
    assert.equal(message.agentName, "coder");
  });
});
