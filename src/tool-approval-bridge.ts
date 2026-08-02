/**
 * Blocking tool-approval bridge for A2A ↔ OpenClaw.
 *
 * OpenClaw 2026.3.2 `before_tool_call` only supports `{ block, params }` (no
 * `requireApproval`). We pause the agent turn by awaiting a Promise in the
 * hook; A2A clients resume via metadata.toolApproval on a follow-up message.
 *
 * IMPORTANT: the bridge MUST be a process-wide singleton (globalThis). OpenClaw
 * can load the plugin module more than once; a module-local singleton then
 * splits registerStream (executor) from before_tool_call (hook) → silent
 * allow-once and missing HITL in the A2A UI.
 */
import { randomUUID } from "node:crypto";

import { TaskState } from "@a2a-js/sdk";
import type { ExecutionEventBus } from "@a2a-js/sdk/server";

import { agentMessage, dataPart, publishStatusUpdate, publishToolArtifact } from "./a2a/helpers.js";
import type { ToolApprovalDecision } from "./tool-approval.js";

export type BridgeApprovalDecision = ToolApprovalDecision | "timeout" | "cancelled";

export type ActiveApprovalStream = {
  eventBus: ExecutionEventBus;
  taskId: string;
  contextId: string;
  runId: string;
  sessionKey?: string;
};

type PendingApproval = {
  approvalId: string;
  callId: string;
  toolName: string;
  runId?: string;
  taskId?: string;
  resolve: (decision: BridgeApprovalDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type RequestApprovalParams = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  runId?: string;
  sessionKey?: string;
  timeoutMs: number;
  /** If set and non-empty, only these tool names require approval. */
  tools?: string[];
};

const GLOBAL_BRIDGE_KEY = "__openclaw_a2a_tool_approval_bridge_v1__";

function summarizeParams(params: Record<string, unknown>): string {
  try {
    const raw = JSON.stringify(params);
    if (raw.length <= 400) return raw;
    return `${raw.slice(0, 400)}…`;
  } catch {
    return "[unserializable params]";
  }
}

/** Normalize OpenClaw / A2A session key variants for Map lookup. */
export function normalizeSessionKey(sessionKey: string | undefined): string | undefined {
  const raw = (sessionKey || "").trim();
  if (!raw) return undefined;
  // OpenClaw lane keys sometimes look like "session:agent:main:a2a:<ctx>".
  return raw.replace(/^session:/, "");
}

function sessionKeysLooselyMatch(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeSessionKey(left);
  const b = normalizeSessionKey(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // agent:main:a2a:<ctx> vs agent:main:<ctx> vs bare <ctx>
  return a.endsWith(b) || b.endsWith(a) || a.includes(b) || b.includes(a);
}

export class ToolApprovalBridge {
  private readonly streamsByRunId = new Map<string, ActiveApprovalStream>();
  private readonly streamsBySessionKey = new Map<string, ActiveApprovalStream>();
  private readonly streamsByTaskId = new Map<string, ActiveApprovalStream>();
  private readonly streamsByContextId = new Map<string, ActiveApprovalStream>();
  /** OpenClaw runId (chatcmpl_*) → A2A stream runId (idempotencyKey). */
  private readonly runIdAliases = new Map<string, string>();
  private readonly pendingByApprovalId = new Map<string, PendingApproval>();
  private readonly pendingByCallId = new Map<string, PendingApproval>();
  /** In-flight approval waits shared across duplicate before_tool_call hooks. */
  private readonly inFlightByCallId = new Map<string, Promise<BridgeApprovalDecision>>();
  /** sessionKey → toolName → true after allow-always */
  private readonly alwaysAllowed = new Map<string, Set<string>>();
  private readonly awaitingTaskIds = new Set<string>();

  /**
   * Map OpenClaw-native runId onto an A2A stream so before_tool_call can find it.
   * Safe no-op when ids are empty or already the stream's own runId.
   */
  aliasRunId(openClawRunId: string | undefined, a2aRunId: string | undefined): void {
    const from = (openClawRunId || "").trim();
    const to = (a2aRunId || "").trim();
    if (!from || !to || from === to) {
      return;
    }
    if (!this.streamsByRunId.has(to)) {
      return;
    }
    this.runIdAliases.set(from, to);
  }

  registerStream(stream: ActiveApprovalStream): void {
    this.streamsByRunId.set(stream.runId, stream);
    this.streamsByTaskId.set(stream.taskId, stream);
    if (stream.contextId) {
      this.streamsByContextId.set(stream.contextId, stream);
    }
    const sessionKey = normalizeSessionKey(stream.sessionKey);
    if (sessionKey) {
      this.streamsBySessionKey.set(sessionKey, stream);
      // Also index the raw key if it differed (e.g. session: prefix).
      if (stream.sessionKey && stream.sessionKey !== sessionKey) {
        this.streamsBySessionKey.set(stream.sessionKey, stream);
      }
    }
  }

  unregisterStream(runId: string): void {
    const stream = this.streamsByRunId.get(runId);
    if (!stream) return;
    this.streamsByRunId.delete(runId);
    this.streamsByTaskId.delete(stream.taskId);
    if (stream.contextId) {
      const current = this.streamsByContextId.get(stream.contextId);
      if (current?.runId === runId) {
        this.streamsByContextId.delete(stream.contextId);
      }
    }
    if (stream.sessionKey) {
      const normalized = normalizeSessionKey(stream.sessionKey);
      for (const key of [stream.sessionKey, normalized]) {
        if (!key) continue;
        const current = this.streamsBySessionKey.get(key);
        if (current?.runId === runId) {
          this.streamsBySessionKey.delete(key);
        }
      }
    }
    for (const [alias, target] of [...this.runIdAliases.entries()]) {
      if (target === runId || alias === runId) {
        this.runIdAliases.delete(alias);
      }
    }
    this.awaitingTaskIds.delete(stream.taskId);

    for (const pending of [...this.pendingByApprovalId.values()]) {
      if (pending.runId === runId) {
        this.settlePending(pending, "cancelled");
      }
    }
  }

  isAwaitingApproval(taskId: string): boolean {
    return this.awaitingTaskIds.has(taskId);
  }

  /** True if an original agent execute() still owns this task's event bus. */
  hasActiveStream(taskId: string): boolean {
    return this.streamsByTaskId.has(taskId);
  }

  /** True while before_tool_call is blocked for this tool call id. */
  isAwaitingCallId(callId: string | undefined): boolean {
    if (!callId) return false;
    return this.pendingByCallId.has(callId);
  }

  activeStreamCount(): number {
    return this.streamsByRunId.size;
  }

  shouldRequireApproval(toolName: string, tools?: string[]): boolean {
    if (!tools || tools.length === 0) return true;
    return tools.includes(toolName);
  }

  isAlwaysAllowed(sessionKey: string | undefined, toolName: string): boolean {
    const normalized = normalizeSessionKey(sessionKey);
    if (normalized && this.alwaysAllowed.get(normalized)?.has(toolName) === true) {
      return true;
    }
    if (sessionKey && this.alwaysAllowed.get(sessionKey)?.has(toolName) === true) {
      return true;
    }
    for (const [key, set] of this.alwaysAllowed.entries()) {
      if (sessionKeysLooselyMatch(key, sessionKey) && set.has(toolName)) {
        return true;
      }
    }
    return false;
  }

  rememberAlwaysAllow(sessionKey: string | undefined, toolName: string): void {
    const key = normalizeSessionKey(sessionKey) || sessionKey;
    if (!key) return;
    let set = this.alwaysAllowed.get(key);
    if (!set) {
      set = new Set();
      this.alwaysAllowed.set(key, set);
    }
    set.add(toolName);
  }

  findStream(params: { runId?: string; sessionKey?: string; contextId?: string }): ActiveApprovalStream | undefined {
    if (params.runId) {
      const byRun = this.streamsByRunId.get(params.runId);
      if (byRun) return byRun;
      const aliased = this.runIdAliases.get(params.runId);
      if (aliased) {
        const byAlias = this.streamsByRunId.get(aliased);
        if (byAlias) return byAlias;
      }
    }

    if (params.sessionKey) {
      const normalized = normalizeSessionKey(params.sessionKey);
      const exact =
        this.streamsBySessionKey.get(params.sessionKey) ||
        (normalized ? this.streamsBySessionKey.get(normalized) : undefined);
      if (exact) return exact;

      const forSession = [...this.streamsByRunId.values()].filter((stream) =>
        sessionKeysLooselyMatch(stream.sessionKey, params.sessionKey),
      );
      if (forSession.length === 1) {
        return forSession[0];
      }
      if (forSession.length > 1) {
        const awaiting = forSession.find((stream) => this.awaitingTaskIds.has(stream.taskId));
        if (awaiting) return awaiting;
        return forSession[forSession.length - 1];
      }
      // Miss on sessionKey must NOT early-return — fall through to context / size===1.
    }

    if (params.contextId) {
      const byCtx = this.streamsByContextId.get(params.contextId);
      if (byCtx) return byCtx;
    }

    // Last resort: single active A2A stream in the process.
    if (this.streamsByRunId.size === 1) {
      return this.streamsByRunId.values().next().value;
    }

    return undefined;
  }

  /**
   * Publish A2A pending_approval + input-required and wait for client decision.
   * Returns the decision; caller should `block` on deny/timeout/cancelled.
   */
  async requestApproval(params: RequestApprovalParams): Promise<BridgeApprovalDecision> {
    if (!this.shouldRequireApproval(params.toolName, params.tools)) {
      return "allow-once";
    }
    if (this.isAlwaysAllowed(params.sessionKey, params.toolName)) {
      return "allow-always";
    }

    const callId = (params.toolCallId || "").trim() || randomUUID();
    const existing = this.inFlightByCallId.get(callId);
    if (existing) {
      // Duplicate before_tool_call (double plugin load) — share the same wait.
      return existing;
    }

    const wait = this.requestApprovalOnce(params, callId);
    this.inFlightByCallId.set(callId, wait);
    try {
      return await wait;
    } finally {
      this.inFlightByCallId.delete(callId);
    }
  }

  private async requestApprovalOnce(
    params: RequestApprovalParams,
    callId: string,
  ): Promise<BridgeApprovalDecision> {
    const stream = this.findStream({
      runId: params.runId,
      sessionKey: params.sessionKey,
    });

    const approvalId = randomUUID();

    // No active A2A stream (e.g. local OpenClaw chat without A2A) — do not block.
    if (!stream) {
      return "allow-once";
    }

    // Learn OpenClaw runId → A2A stream for subsequent tool calls in this turn.
    this.aliasRunId(params.runId, stream.runId);

    this.awaitingTaskIds.add(stream.taskId);

    publishToolArtifact(stream.eventBus, stream.taskId, stream.contextId, {
      kind: "tool",
      callId,
      name: params.toolName,
      phase: "start",
      status: "pending_approval",
      approvalId,
      input: params.params,
    });

    publishStatusUpdate(
      stream.eventBus,
      stream.taskId,
      stream.contextId,
      TaskState.TASK_STATE_INPUT_REQUIRED,
      {
        statusMessage: agentMessage(stream.contextId, [
          dataPart({
            kind: "toolApproval",
            approvalId,
            callId,
            name: params.toolName,
            reason: `Allow ${params.toolName}: ${summarizeParams(params.params)}`,
          }),
        ], stream.taskId),
      },
    );

    const decision = await new Promise<BridgeApprovalDecision>((resolve) => {
      const pending: PendingApproval = {
        approvalId,
        callId,
        toolName: params.toolName,
        runId: stream.runId,
        taskId: stream.taskId,
        resolve,
      };
      if (params.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.settlePending(pending, "timeout");
        }, params.timeoutMs);
      }
      this.pendingByApprovalId.set(approvalId, pending);
      this.pendingByCallId.set(callId, pending);
    });

    this.awaitingTaskIds.delete(stream.taskId);

    if (decision === "allow-always") {
      this.rememberAlwaysAllow(params.sessionKey, params.toolName);
    }

    if (decision === "allow-once" || decision === "allow-always") {
      publishToolArtifact(stream.eventBus, stream.taskId, stream.contextId, {
        kind: "tool",
        callId,
        name: params.toolName,
        phase: "start",
        status: "running",
        approvalId,
        input: params.params,
      });
      publishStatusUpdate(
        stream.eventBus,
        stream.taskId,
        stream.contextId,
        TaskState.TASK_STATE_WORKING,
      );
    } else if (decision === "deny" || decision === "timeout" || decision === "cancelled") {
      // Clear PENDING_APPROVAL in the live stream so clients stop offering approve buttons.
      publishToolArtifact(stream.eventBus, stream.taskId, stream.contextId, {
        kind: "tool",
        callId,
        name: params.toolName,
        phase: "result",
        status: decision === "deny" ? "rejected" : "failed",
        approvalId,
        input: params.params,
        isError: decision !== "deny",
        output: {
          error:
            decision === "deny"
              ? `Tool "${params.toolName}" denied by user`
              : `Tool "${params.toolName}" approval ${decision}`,
        },
      });
    }

    return decision;
  }

  /**
   * Resolve a pending approval from an inbound A2A toolApproval message.
   * @returns true if a pending wait was settled.
   */
  resolve(
    approvalId: string,
    decision: ToolApprovalDecision,
    callId?: string,
  ): boolean {
    const pending =
      this.pendingByApprovalId.get(approvalId) ||
      (callId ? this.pendingByCallId.get(callId) : undefined);
    if (!pending) {
      return false;
    }
    this.settlePending(pending, decision);
    return true;
  }

  private settlePending(pending: PendingApproval, decision: BridgeApprovalDecision): void {
    if (!this.pendingByApprovalId.has(pending.approvalId)) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingByApprovalId.delete(pending.approvalId);
    this.pendingByCallId.delete(pending.callId);
    if (pending.taskId) {
      this.awaitingTaskIds.delete(pending.taskId);
    }
    pending.resolve(decision);
  }
}

function getProcessBridge(): ToolApprovalBridge {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_BRIDGE_KEY]?: ToolApprovalBridge;
  };
  if (!g[GLOBAL_BRIDGE_KEY]) {
    g[GLOBAL_BRIDGE_KEY] = new ToolApprovalBridge();
  }
  return g[GLOBAL_BRIDGE_KEY];
}

/** Process-wide bridge shared by plugin hook + A2A executor (survives double module load). */
export const toolApprovalBridge = getProcessBridge();
