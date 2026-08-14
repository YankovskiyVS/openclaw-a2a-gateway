#!/usr/bin/env node
/** Live smoke test for the complete five-plugin OpenClaw stack. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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

const execFileAsync = promisify(execFile);
const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.dirname(repoDir);
const judgeDir = path.join(workspaceDir, "llm-approve-openclaw-plugin");
const nangoDir = path.join(workspaceDir, "nango-openclaw-plugin");
const apiKey = process.env.CLOUDRU_API_KEY?.trim();
const image = process.env.OPENCLAW_IMAGE || "ghcr.io/openclaw/openclaw:2026.7.1-2";
const a2aPort = Number(process.env.FIVE_PLUGIN_A2A_PORT || 28_800);
const gatewayPort = Number(process.env.FIVE_PLUGIN_GATEWAY_PORT || 29_080);
const nangoPort = Number(process.env.FIVE_PLUGIN_NANGO_PORT || 30_081);
const timeoutMs = Number(process.env.FIVE_PLUGIN_TIMEOUT_MS || 300_000);
const containerName = `openclaw-five-plugin-smoke-${process.pid}`;
const pluginIds = [
  "a2a-gateway", "browser", "diagnostics-otel", "llm-action-judge", "nango-proxy",
];

assert.ok(apiKey, "CLOUDRU_API_KEY is required for this opt-in live test");
for (const port of [a2aPort, gatewayPort, nangoPort]) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, `invalid port: ${port}`);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const redact = (value) => String(value).split(apiKey).join("[REDACTED]");

function config() {
  return {
    gateway: {
      mode: "local",
      port: 19_080,
      bind: "lan",
      auth: { mode: "token", token: "five-plugin-local-smoke-token" },
    },
    agents: {
      defaults: {
        model: { primary: "cloudru/Qwen/Qwen3.6-35B-A3B" },
        models: { "cloudru/Qwen/Qwen3.6-35B-A3B": { alias: "Cloud.ru Qwen" } },
      },
    },
    models: {
      mode: "merge",
      providers: {
        cloudru: {
          baseUrl: "https://foundation-models.api.cloud.ru/v1",
          apiKey: "${CLOUDRU_API_KEY}",
          api: "openai-completions",
          models: [{
            id: "Qwen/Qwen3.6-35B-A3B",
            name: "Qwen3.6 35B A3B (Cloud.ru)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131_072,
            maxTokens: 2_500,
            compat: { requiresStringContent: true },
          }],
        },
      },
    },
    plugins: {
      allow: pluginIds,
      load: { paths: ["/plugins/a2a", "/plugins/judge", "/plugins/nango"] },
      entries: {
        "a2a-gateway": {
          enabled: true,
          config: {
            agentCard: {
              name: "Five Plugin Stack",
              url: `http://127.0.0.1:${a2aPort}/a2a/jsonrpc`,
              skills: [{
                id: "integration",
                name: "integration",
                description: "Five-plugin integration smoke",
              }],
            },
            server: { host: "0.0.0.0", port: 18_800, grpcEnabled: false },
            storage: {
              tasksDir: "/tmp/openclaw-state/a2a-tasks",
              taskTtlHours: 1,
              cleanupIntervalMinutes: 5,
            },
            routing: { defaultAgentId: "main", rules: [] },
            toolApproval: { enabled: false },
          },
        },
        browser: { enabled: true },
        "diagnostics-otel": { enabled: true },
        "llm-action-judge": {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: { mode: "autonomous", enforcement: "shadow" },
        },
        "nango-proxy": {
          enabled: true,
          config: {
            proxyBaseUrl: `http://host.docker.internal:${nangoPort}`,
            apiKeyEnv: "CLOUDRU_API_KEY",
          },
        },
      },
    },
    browser: { enabled: true, headless: true },
    diagnostics: {
      enabled: true,
      otel: {
        enabled: true,
        traces: false,
        metrics: false,
        logs: true,
        logsExporter: "stdout",
        serviceName: "openclaw-five-plugin-smoke",
        captureContent: { enabled: false },
      },
    },
  };
}

function nangoMock() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const record = {
      method: request.method,
      url: request.url,
      authorized: request.headers.authorization === `Api-Key ${apiKey}`,
    };
    requests.push(record);
    const expectedUrl = "/api/v1/stack-project/evo-claws/stack-agent/connections";
    if (record.method !== "GET" || record.url !== expectedUrl || !record.authorized) {
      response.writeHead(record.authorized ? 404 : 401);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ connections: [
      { type: "github", connectionId: "github-smoke", status: "active", enabled: true },
      { type: "yandex-disk", connectionId: "disk-smoke", status: "active", enabled: true },
    ] }));
  });
  return {
    requests,
    ready: new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(nangoPort, "0.0.0.0", resolve);
    }),
    close: () => new Promise((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function startOpenClaw(tempDir, envFile) {
  const args = [
    "run", "--rm", "--name", containerName,
    "--add-host", "host.docker.internal:host-gateway",
    "--env-file", envFile,
    "--env", "OPENCLAW_CONFIG_PATH=/smoke/openclaw.json",
    "--env", "OPENCLAW_STATE_DIR=/tmp/openclaw-state",
    "-p", `127.0.0.1:${a2aPort}:18800`,
    "-p", `127.0.0.1:${gatewayPort}:19080`,
    "-v", `${tempDir}:/smoke`,
    "-v", `${repoDir}:/plugins/a2a:ro`,
    "-v", `${judgeDir}:/plugins/judge:ro`,
    "-v", `${nangoDir}:/plugins/nango:ro`,
    image, "node", "openclaw.mjs", "gateway",
  ];
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const append = (chunk) => { logs += redact(chunk); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return { child, logs: () => logs };
}

async function stopContainer() {
  try {
    await execFileAsync("docker", ["stop", "--time", "5", containerName], { timeout: 15_000 });
  } catch {
    // --rm may already have removed it.
  }
}

async function waitUntilReady(openClaw) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${a2aPort}/.well-known/agent-card.json`;
  while (Date.now() < deadline) {
    if (openClaw.child.exitCode !== null) {
      throw new Error(`OpenClaw exited early\n${openClaw.logs()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response.json();
    } catch {}
    await delay(500);
  }
  throw new Error(`OpenClaw startup timeout\n${openClaw.logs()}`);
}

async function sendTask() {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver(),
      transports: [new JsonRpcTransportFactory(), new RestTransportFactory()],
    }),
  );
  const client = await factory.createFromUrl(`http://127.0.0.1:${a2aPort}`);
  const messageId = randomUUID();
  const initial = await client.sendMessage({
    tenant: "",
    message: {
      messageId,
      contextId: "",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [textPart([
        "Call the nango_list_connections tool exactly once.",
        "Report every connection type and status. Do not call any other tool.",
        "End with FIVE_PLUGIN_STACK_OK.",
      ].join("\n"))],
      metadata: { liveTestCase: "five-plugin-stack" },
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
  assert.ok(isTask(initial), "A2A send must return a Task");
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["completed", "failed", "canceled", "rejected"]);
  let task = initial;
  while (!terminal.has(normalizeTaskState(task?.status?.state))) {
    assert.ok(Date.now() < deadline, `A2A task timed out: ${initial.id}`);
    await delay(1_000);
    task = await client.getTask({ tenant: "", id: initial.id, historyLength: 50 });
  }
  assert.equal(normalizeTaskState(task?.status?.state), "completed");
  const text = taskResponseText(task);
  assert.match(text, /FIVE_PLUGIN_STACK_OK/);
  assert.match(text, /github/i);
  assert.match(text, /yandex[- ]disk/i);
  return initial.id;
}

async function judgeAudit() {
  const { stdout } = await execFileAsync("docker", [
    "exec", containerName, "cat", "/tmp/openclaw-state/logs/llm-action-judge.jsonl",
  ]);
  return stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
}

let tempDir;
let openClaw;
const mock = nangoMock();
const startedAt = Date.now();
try {
  await mock.ready;
  tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-five-plugin-"));
  const configFile = path.join(tempDir, "openclaw.json");
  const envFile = path.join(tempDir, "live.env");
  await writeFile(configFile, `${JSON.stringify(config(), null, 2)}\n`, { mode: 0o600 });
  await writeFile(envFile, [
    `CLOUDRU_API_KEY=${apiKey}`,
    `OPENCLAW_JUDGE_API_KEY=${apiKey}`,
    "OPENCLAW_JUDGE_PROFILE=shadow",
    "OPENCLAW_JUDGE_LOG_LEVEL=info",
    "EVOLUTION_PROJECT_ID=stack-project",
    "EVOCLAW_ID=stack-agent",
    `NANGO_PROXY_URL=http://host.docker.internal:${nangoPort}`,
    "",
  ].join("\n"), { mode: 0o600 });

  openClaw = startOpenClaw(tempDir, envFile);
  const agentCard = await waitUntilReady(openClaw);
  const taskStartedAt = Date.now();
  const taskId = await sendTask();
  const audit = (await judgeAudit()).filter((entry) =>
    entry.tool_name === "nango_list_connections"
  );
  const logs = openClaw.logs();

  assert.deepEqual(mock.requests, [{
    method: "GET",
    url: "/api/v1/stack-project/evo-claws/stack-agent/connections",
    authorized: true,
  }]);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].decision_source, "llm");
  assert.equal(audit[0].decision, "allow");
  assert.equal(audit[0].outcome, "allow");
  assert.match(logs, /http server listening \(5 plugins: a2a-gateway, browser, diagnostics-otel, llm-action-judge, nango-proxy;/);
  assert.match(logs, /\[nango-proxy\] v0\.5\.0 registered 57 tools/);
  assert.match(logs, /LLM action judge registered/);
  assert.match(logs, /openclaw-five-plugin-smoke/);
  console.log(JSON.stringify({
    image,
    plugins: pluginIds,
    agentCard: agentCard.name,
    taskId,
    taskElapsedMs: Date.now() - taskStartedAt,
    elapsedMs: Date.now() - startedAt,
    nangoRequests: mock.requests.length,
    judge: { source: audit[0].decision_source, decision: audit[0].decision },
    diagnosticsService: "openclaw-five-plugin-smoke",
    marker: "FIVE_PLUGIN_STACK_OK",
  }, null, 2));
} catch (error) {
  if (openClaw?.logs()) console.error(redact(openClaw.logs()));
  throw error;
} finally {
  await stopContainer();
  if (openClaw?.child.exitCode === null) {
    await Promise.race([
      new Promise((resolve) => openClaw.child.once("exit", resolve)),
      delay(10_000),
    ]);
  }
  await mock.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
}
