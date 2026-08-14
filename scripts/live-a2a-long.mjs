#!/usr/bin/env node
/**
 * Opt-in live A2A soak test for an already running OpenClaw gateway.
 *
 * Usage:
 *   A2A_PEER_URL=http://127.0.0.1:28800 npm run test:live:a2a
 *
 * This test intentionally sends long prompts. It verifies asynchronous queueing,
 * numeric SDK 1.0.1 task states, stable task IDs on a duplicate delivery, and
 * non-empty model responses. It never reads model credentials.
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
  isTask,
  normalizeTaskState,
  taskResponseText,
  textPart,
} from "../skill/scripts/a2a-proto.mjs";

const peerUrl = process.env.A2A_PEER_URL || "http://127.0.0.1:28800";
const timeoutMs = Number(process.env.LIVE_A2A_TIMEOUT_MS || 600_000);
const pollMs = Number(process.env.LIVE_A2A_POLL_MS || 2_000);

const cases = [
  {
    name: "delivery-architecture",
    prompt: `Подготовь развёрнутый инженерный документ по надёжной передаче сообщений A2A. Обязательно включи: модель отказов, идемпотентность, дедлайны, retry с jitter, устойчивое хранение, порядок сообщений, backpressure, отмену, observability, псевдокод и не менее 20 тест-кейсов. Сравни минимум три архитектурных варианта, выбери один и объясни компромиссы. Ответ должен быть объёмным, но уложиться в 700–850 слов. Заверши маркером LONG_A2A_ARCH_DONE.`,
  },
  {
    name: "adversarial-review",
    prompt: `Проведи adversarial review A2A gateway как senior distributed-systems engineer. Последовательно разбери потерю ответа после принятия запроса, повторную доставку, stale Agent Card, падение WebSocket, исчерпание очереди, зависший model call, cancellation race и restart процесса. Дай risk register, детальный test plan, метрики/SLO и план устранения рисков. Ответ должен быть объёмным, но уложиться в 700–850 слов. Заверши маркером LONG_A2A_REVIEW_DONE.`,
  },
  {
    name: "migration-plan",
    prompt: `Спроектируй миграцию production multi-agent системы на A2A 1.0 и OpenClaw. Сделай три итерации дизайна, сравни их по надёжности, стоимости и сложности, затем выбери итоговый вариант. Включи схемы потоков в текстовом виде, rollout по этапам, rollback, chaos-тесты, безопасность, capacity planning и runbook инцидентов. Ответ должен быть объёмным, но уложиться в 700–850 слов. Заверши маркером LONG_A2A_MIGRATION_DONE.`,
  },
];

function messageRequest(testCase) {
  const messageId = randomUUID();
  return {
    messageId,
    request: {
      tenant: "",
      message: {
        messageId,
        contextId: "",
        taskId: "",
        role: Role.ROLE_USER,
        parts: [textPart(testCase.prompt)],
        metadata: { liveTestCase: testCase.name },
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: ["text"],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    },
  };
}

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    cardResolver: new DefaultAgentCardResolver(),
    transports: [new JsonRpcTransportFactory(), new RestTransportFactory()],
  }),
);
const client = await factory.createFromUrl(peerUrl);
const jobs = cases.map((testCase) => ({ testCase, ...messageRequest(testCase), transitions: [] }));
const startedAt = Date.now();

const initial = await Promise.all(jobs.map((job) => client.sendMessage(job.request)));
for (let index = 0; index < jobs.length; index += 1) {
  assert.ok(isTask(initial[index]), `${jobs[index].testCase.name}: non-blocking send must return Task`);
  jobs[index].taskId = initial[index].id;
  assert.equal(jobs[index].taskId, jobs[index].messageId, `${jobs[index].testCase.name}: stable task id`);
}

// Simulate a client retry after losing the first HTTP response.
const duplicate = await client.sendMessage(jobs[0].request);
assert.ok(isTask(duplicate), "duplicate delivery must return the existing Task");
assert.equal(duplicate.id, jobs[0].taskId, "duplicate delivery must preserve task id");
console.log(`[live-a2a] queued ${jobs.length} long tasks; duplicate task=${duplicate.id}`);

const terminal = new Set(["completed", "failed", "canceled", "rejected"]);
let pending = new Set(jobs.map((job) => job.taskId));
let finalTasks = new Map();

while (pending.size > 0) {
  if (Date.now() - startedAt > timeoutMs) {
    throw new Error(`live A2A timeout after ${timeoutMs}ms; pending=${[...pending].join(",")}`);
  }

  const snapshots = await Promise.all(
    jobs
      .filter((job) => pending.has(job.taskId))
      .map(async (job) => ({
        job,
        task: await client.getTask({ tenant: "", id: job.taskId, historyLength: 50 }),
      })),
  );

  for (const { job, task } of snapshots) {
    const state = normalizeTaskState(task?.status?.state);
    if (job.transitions.at(-1)?.state !== state) {
      const transition = { state, atMs: Date.now() - startedAt };
      job.transitions.push(transition);
      console.log(`[live-a2a] ${job.testCase.name}: ${state} at ${transition.atMs}ms`);
    }
    if (terminal.has(state)) {
      pending.delete(job.taskId);
      finalTasks.set(job.taskId, task);
    }
  }

  if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
}

const summary = jobs.map((job) => {
  const task = finalTasks.get(job.taskId);
  const state = normalizeTaskState(task?.status?.state);
  const text = taskResponseText(task);
  const repeatedInputCount = (task?.history || []).filter(
    (message) => message?.messageId === job.messageId,
  ).length;

  assert.equal(state, "completed", `${job.testCase.name}: terminal state`);
  assert.ok(text.length >= 1_000, `${job.testCase.name}: expected a substantial response, got ${text.length} chars`);
  assert.ok(repeatedInputCount <= 1, `${job.testCase.name}: duplicate input was added to history`);

  return {
    name: job.testCase.name,
    taskId: job.taskId,
    state,
    responseChars: text.length,
    inputCopiesInHistory: repeatedInputCount,
    transitions: job.transitions,
    marker: text.match(/LONG_A2A_[A-Z_]+_DONE/)?.[0] || null,
  };
});

console.log(JSON.stringify({
  peerUrl,
  elapsedMs: Date.now() - startedAt,
  duplicateStableTaskId: duplicate.id === jobs[0].taskId,
  tasks: summary,
}, null, 2));
