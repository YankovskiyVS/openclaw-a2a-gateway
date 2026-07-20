/**
 * Blocking tool-approval bridge for A2A ↔ OpenClaw.
 *
 * OpenClaw 2026.3.2 `before_tool_call` only supports `{ block, params }` (no
 * `requireApproval`). We pause the agent turn by awaiting a Promise in the
 * hook; A2A clients resume via metadata.toolApproval on a follow-up message.
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

function summarizeParams(params: Record<string, unknown>): string {
  try {
    const raw = JSON.stringify(params);
    if (raw.length <= 400) return raw;
    return `${raw.slice(0, 400)}…`;
  } catch {
    return "[unserializable params]";
  }
}

export class ToolApprovalBridge {
  private readonly streamsByRunId = new Map<string, ActiveApprovalStream>();
  private readonly streamsBySessionKey = new Map<string, ActiveApprovalStream>();
  private readonly streamsByTaskId = new Map<string, ActiveApprovalStream>();
  private readonly pendingByApprovalId = new Map<string, PendingApproval>();
  private readonly pendingByCallId = new Map<string, PendingApproval>();
  /** sessionKey → toolName → true after allow-always */
  private readonly alwaysAllowed = new Map<string, Set<string>>();
  private readonly awaitingTaskIds = new Set<string>();

  registerStream(stream: ActiveApprovalStream): void {
    this.streamsByRunId.set(stream.runId, stream);
    this.streamsByTaskId.set(stream.taskId, stream);
    if (stream.sessionKey) {
      this.streamsBySessionKey.set(stream.sessionKey, stream);
    }
  }

  unregisterStream(runId: string): void {
    const stream = this.streamsByRunId.get(runId);
    if (!stream) return;
    this.streamsByRunId.delete(runId);
    this.streamsByTaskId.delete(stream.taskId);
    if (stream.sessionKey) {
      const current = this.streamsBySessionKey.get(stream.sessionKey);
      if (current?.runId === runId) {
        this.streamsBySessionKey.delete(stream.sessionKey);
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

  shouldRequireApproval(toolName: string, tools?: string[]): boolean {
    if (!tools || tools.length === 0) return true;
    return tools.includes(toolName);
  }

  isAlwaysAllowed(sessionKey: string | undefined, toolName: string): boolean {
    if (!sessionKey) return false;
    return this.alwaysAllowed.get(sessionKey)?.has(toolName) === true;
  }

  rememberAlwaysAllow(sessionKey: string | undefined, toolName: string): void {
    if (!sessionKey) return;
    let set = this.alwaysAllowed.get(sessionKey);
    if (!set) {
      set = new Set();
      this.alwaysAllowed.set(sessionKey, set);
    }
    set.add(toolName);
  }

  findStream(params: { runId?: string; sessionKey?: string }): ActiveApprovalStream | undefined {
    if (params.runId) {
      const byRun = this.streamsByRunId.get(params.runId);
      if (byRun) return byRun;
    }
    if (params.sessionKey) {
      return this.streamsBySessionKey.get(params.sessionKey);
    }
    // Last resort: single active stream (common for one concurrent A2A task).
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

    const stream = this.findStream({
      runId: params.runId,
      sessionKey: params.sessionKey,
    });

    const callId = (params.toolCallId || "").trim() || randomUUID();
    const approvalId = randomUUID();

    // No active A2A stream (e.g. local chat without A2A) — do not block.
    if (!stream) {
      return "allow-once";
    }

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

/** Process-wide bridge shared by plugin hook + A2A executor. */
export const toolApprovalBridge = new ToolApprovalBridge();
