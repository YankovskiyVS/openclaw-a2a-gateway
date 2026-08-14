#!/usr/bin/env node
/**
 * Live A2A scenario: one user message followed by exactly twenty agent messages.
 * Nineteen messages mirror real tool lifecycle events; the twentieth is final.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from "@a2a-js/sdk/client";
import {
  Role,
  extractTextParts,
  isTask,
  normalizeTaskState,
  textPart,
} from "../skill/scripts/a2a-proto.mjs";

const peerUrl = process.env.A2A_PEER_URL || "http://127.0.0.1:28800";
const timeoutMs = Number(process.env.LIVE_A2A_TIMEOUT_MS || 600_000);
const pollMs = Number(process.env.LIVE_A2A_POLL_MS || 2_000);
const progressLimit = 19;
const expectedAgentMessages = 20;

const prompt = [
  "Выполни реальное исследование через инструмент browser.",
  "Сделай не меньше 10 отдельных вызовов browser: открывай страницы, делай snapshot/чтение, переходи по ссылкам и проверяй содержимое.",
  "Исследуй официальную документацию и GitHub OpenClaw: архитектуру Gateway, плагины, browser automation, sessions и безопасность.",
  "Не имитируй вызовы текстом и не заканчивай раньше 10 вызовов инструмента.",
  "В финале кратко перечисли посещённые источники, факты и возникшие ошибки инструментов.",
  "Последней строкой напиши TWENTY_AGENT_MESSAGES_OK.",
].join("\n");

function roleIs(role, expected, fallbackName) {
  return role === expected ||
    (typeof role === "string" && role.replace(/^ROLE_/, "").toLowerCase() === fallbackName);
}

function messageText(message) {
  return extractTextParts(message?.parts) || "";
}

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver: new DefaultAgentCardResolver(),
    transports: [new JsonRpcTransportFactory(), new RestTransportFactory()],
  }),
);
const client = await factory.createFromUrl(peerUrl);
const messageId = randomUUID();
const startedAt = Date.now();

const initial = await client.sendMessage({
  tenant: "",
  message: {
    messageId,
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [textPart(prompt)],
    metadata: {
      liveTestCase: "one-user-twenty-agent-browser",
      toolProgressMessagesLimit: progressLimit,
    },
    extensions: [],
    referenceTaskIds: [],
  },
  configuration: {
    acceptedOutputModes: ["text"],
    taskPushNotificationConfig: undefined,
    returnImmediately: true,
  },
  metadata: undefined,
});

assert.ok(isTask(initial), "non-blocking send must return Task");
const taskId = initial.id;
console.log("[live-a2a-20] queued task=" + taskId);

const terminal = new Set(["completed", "failed", "canceled", "rejected"]);
let task;
let previousState = "";

for (;;) {
  if (Date.now() - startedAt > timeoutMs) {
    throw new Error("live A2A timeout after " + timeoutMs + "ms; task=" + taskId);
  }
  task = await client.getTask({ tenant: "", id: taskId, historyLength: 50 });
  const state = normalizeTaskState(task?.status?.state);
  if (state !== previousState) {
    console.log("[live-a2a-20] state=" + state + " at " + (Date.now() - startedAt) + "ms");
    previousState = state;
  }
  if (terminal.has(state)) break;
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

const state = normalizeTaskState(task?.status?.state);
assert.equal(state, "completed", "task must complete");

const history = task?.history || [];
const userMessages = history.filter((message) =>
  roleIs(message?.role, Role.ROLE_USER, "user")
);
const agentMessages = history.filter((message) =>
  roleIs(message?.role, Role.ROLE_AGENT, "agent")
);

assert.equal(history.length, 21, "history must contain exactly 21 messages");
assert.equal(userMessages.length, 1, "history must contain exactly one user message");
assert.equal(agentMessages.length, expectedAgentMessages, "history must contain exactly twenty agent messages");

const progressMessages = agentMessages.slice(0, progressLimit);
for (let index = 0; index < progressMessages.length; index += 1) {
  const expectedPrefix = "[tool-progress " + (index + 1) + "/" + progressLimit + "]";
  assert.ok(
    messageText(progressMessages[index]).startsWith(expectedPrefix),
    "agent message " + (index + 1) + " must be a real tool progress message",
  );
}

const finalText = messageText(agentMessages.at(-1));
assert.match(finalText, /TWENTY_AGENT_MESSAGES_OK/, "final marker");
const progressText = progressMessages.map(messageText).join("\n");
assert.match(progressText, /Calling browser/i, "browser start events must be present");
assert.match(progressText, /browser (result|failed)/i, "browser result events must be present");

const toolCalls = progressMessages.filter((message) =>
  /\] Calling /.test(messageText(message))
).length;
const toolResults = progressMessages.filter((message) =>
  /\] .+ (result|failed)(?::|$)/.test(messageText(message))
).length;

console.log("[live-a2a-20] message transcript");
for (let index = 0; index < agentMessages.length; index += 1) {
  const compact = messageText(agentMessages[index]).replace(/\s+/g, " ").slice(0, 700);
  console.log(String(index + 1).padStart(2, "0") + ". " + compact);
}

console.log(JSON.stringify({
  peerUrl,
  taskId,
  elapsedMs: Date.now() - startedAt,
  state,
  historyMessages: history.length,
  userMessages: userMessages.length,
  agentMessages: agentMessages.length,
  progressMessages: progressMessages.length,
  toolCalls,
  toolResults,
  finalMarker: "TWENTY_AGENT_MESSAGES_OK",
}, null, 2));
