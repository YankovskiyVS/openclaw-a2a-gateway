import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { A2AClient } from "../src/client.js";
import type { PeerConfig } from "../src/types.js";

const peer: PeerConfig = {
  name: "reliable-peer",
  agentCardUrl: "http://reliable-peer/.well-known/agent-card.json",
};

function agentCard(interfaces = [
  { url: "http://reliable-peer/a2a/jsonrpc", protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" },
]) {
  return {
    name: "Reliable Peer",
    description: "Reliability fixture",
    version: "1.0.0",
    supportedInterfaces: interfaces,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [],
    signatures: [],
  };
}

function successJsonRpc(request: Record<string, unknown>, suffix = "ok"): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      message: {
        messageId: `reply-${suffix}`,
        contextId: "",
        taskId: "",
        role: "ROLE_AGENT",
        parts: [{ text: suffix }],
        extensions: [],
        referenceTaskIds: [],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function successRest(suffix = "rest-ok"): Response {
  return new Response(JSON.stringify({
    message: {
      messageId: `reply-${suffix}`,
      contextId: "",
      taskId: "",
      role: "ROLE_AGENT",
      parts: [{ text: suffix }],
      extensions: [],
      referenceTaskIds: [],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function requestMessageId(request: Record<string, unknown>): string {
  const params = request.params as Record<string, unknown>;
  const message = params.message as Record<string, unknown>;
  return String(message.messageId);
}

describe("A2AClient outbound reliability", () => {
  it("uses one Agent Card lookup for a successful send", async () => {
    const originalFetch = globalThis.fetch;
    let cardLookups = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(".well-known")) {
        cardLookups += 1;
        return new Response(JSON.stringify(agentCard()), {
          headers: { "content-type": "application/json" },
        });
      }
      return successJsonRpc(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }) as typeof fetch;

    const client = new A2AClient();
    try {
      const result = await client.sendMessage(peer, { text: "hello" });
      assert.equal(result.ok, true);
      assert.equal(cardLookups, 1);
    } finally {
      client.destroy();
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps messageId stable across a retry and refreshes the Agent Card", async () => {
    const originalFetch = globalThis.fetch;
    const messageIds: string[] = [];
    let cardLookups = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(".well-known")) {
        cardLookups += 1;
        return new Response(JSON.stringify(agentCard()), {
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      messageIds.push(requestMessageId(request));
      if (messageIds.length === 1) throw new TypeError("fetch failed after remote accept");
      return successJsonRpc(request, "retried");
    }) as typeof fetch;

    const client = new A2AClient();
    try {
      const result = await client.sendMessage(peer, { text: "retry me" }, {
        retryConfig: { maxRetries: 1, baseDelayMs: 0, maxDelayMs: 0 },
      });
      assert.equal(result.ok, true);
      assert.equal(messageIds.length, 2);
      assert.ok(messageIds[0]);
      assert.equal(messageIds[1], messageIds[0]);
      assert.equal(cardLookups, 2, "a retry must refresh a potentially stale card");
    } finally {
      client.destroy();
      globalThis.fetch = originalFetch;
    }
  });

  it("coalesces concurrent Agent Card lookups", async () => {
    const originalFetch = globalThis.fetch;
    let cardLookups = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(".well-known")) {
        cardLookups += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify(agentCard()), {
          headers: { "content-type": "application/json" },
        });
      }
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return successJsonRpc(request, String(request.id));
    }) as typeof fetch;

    const client = new A2AClient();
    try {
      const results = await Promise.all([
        client.sendMessage(peer, { text: "one" }),
        client.sendMessage(peer, { text: "two" }),
      ]);
      assert.ok(results.every((result) => result.ok));
      assert.equal(cardLookups, 1);
    } finally {
      client.destroy();
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back after a timed-out transport using a fresh deadline", async () => {
    const originalFetch = globalThis.fetch;
    let jsonRpcAttempts = 0;
    let restAttempts = 0;
    const interfaces = [
      { url: "http://reliable-peer/a2a/jsonrpc", protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" },
      { url: "http://reliable-peer/a2a/rest", protocolBinding: "HTTP+JSON", protocolVersion: "1.0", tenant: "" },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(".well-known")) {
        return new Response(JSON.stringify(agentCard(interfaces)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/a2a/jsonrpc")) {
        jsonRpcAttempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (url.includes("/a2a/rest")) {
        restAttempts += 1;
        return successRest();
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new A2AClient({ requestTimeoutMs: 30 });
    // AbortSignal.timeout uses an unref'd timer in Node; keep this isolated test
    // alive long enough to observe the abort exactly as a running gateway would.
    const keepAlive = setTimeout(() => undefined, 250);
    try {
      const result = await client.sendMessage(peer, { text: "fallback" });
      assert.equal(result.ok, true);
      assert.equal(jsonRpcAttempts, 1);
      assert.equal(restAttempts, 1);
    } finally {
      clearTimeout(keepAlive);
      client.destroy();
      globalThis.fetch = originalFetch;
    }
  });
});
