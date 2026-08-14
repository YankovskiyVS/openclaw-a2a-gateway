import type { Message, TaskStatus } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";
import type {
  AgentExecutionEvent,
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import { AgentEvent } from "@a2a-js/sdk/server";

import {
  agentMessage,
  buildTask,
  partText,
  publishStatusUpdate,
  terminalStateLabel,
  textPart,
} from "./a2a/helpers.js";
import { GatewayTelemetry } from "./telemetry.js";
import { computeSaturationDelay, type SaturationConfig } from "./saturation-model.js";
import { isInterruptOnlyMessage } from "./interrupt.js";
import { isToolApprovalOnlyMessage } from "./tool-approval.js";

interface QueueingExecutorOptions {
  /**
   * Max concurrent tasks **per A2A session** (contextId).
   * Different sessions run in parallel independently.
   */
  maxConcurrentTasks: number;
  /**
   * Max queued tasks **per A2A session** before rejection.
   */
  maxQueuedTasks: number;
  /** Bio-inspired Michaelis-Menten soft concurrency config (applied per session). */
  saturation?: SaturationConfig;
}

interface QueuedTaskEntry {
  requestContext: RequestContext;
  eventBus: ExecutionEventBus;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface SessionLane {
  /** Session key = A2A contextId (chat / conversation). */
  sessionKey: string;
  queue: QueuedTaskEntry[];
  /** Includes tasks already accepted to run (reserved before async work starts). */
  activeTasks: number;
}

type TerminalTaskState = "completed" | "failed" | "canceled" | "rejected";

function statusMessage(contextId: string, text: string, taskId = ""): Message {
  return agentMessage(contextId, [textPart(text)], taskId);
}

function taskEvent(
  taskId: string,
  contextId: string,
  state: TaskState,
  text?: string,
): AgentExecutionEvent {
  return AgentEvent.task(
    buildTask(taskId, contextId, state, {
      statusMessage: text ? statusMessage(contextId, text, taskId) : undefined,
    }),
  );
}

function createObservedEventBus(
  eventBus: ExecutionEventBus,
  observer: (event: AgentExecutionEvent) => void,
): ExecutionEventBus {
  const wrapped: ExecutionEventBus = {
    publish(event) {
      observer(event);
      eventBus.publish(event);
    },
    on(eventName, listener) {
      eventBus.on(eventName, listener);
      return wrapped;
    },
    off(eventName, listener) {
      eventBus.off(eventName, listener);
      return wrapped;
    },
    once(eventName, listener) {
      eventBus.once(eventName, listener);
      return wrapped;
    },
    removeAllListeners(eventName) {
      eventBus.removeAllListeners(eventName);
      return wrapped;
    },
    finished() {
      eventBus.finished();
    },
  };

  return wrapped;
}

function resolveTerminalStatus(event: AgentExecutionEvent): TaskStatus | undefined {
  if (event.kind === "task") {
    return event.data.status;
  }
  if (event.kind === "statusUpdate") {
    return event.data.status;
  }
  return undefined;
}

function sessionKeyFromContext(requestContext: RequestContext): string {
  const contextId = (requestContext.contextId || "").trim();
  return contextId || "__default__";
}

/** Control-plane messages must not wait behind the agent turn they are meant to unblock/stop. */
function isSessionQueueBypassMessage(requestContext: RequestContext): boolean {
  return (
    isInterruptOnlyMessage(requestContext.userMessage) ||
    isToolApprovalOnlyMessage(requestContext.userMessage)
  );
}

export class QueueingAgentExecutor implements AgentExecutor {
  private readonly delegate: AgentExecutor;
  private readonly telemetry: GatewayTelemetry;
  private readonly options: QueueingExecutorOptions;
  private readonly defaultAgentId: string;
  /** Per-session lanes: queue + concurrency are scoped to A2A contextId. */
  private readonly lanes = new Map<string, SessionLane>();
  private readonly pendingByTaskId = new Map<string, { entry: QueuedTaskEntry; sessionKey: string }>();
  /** Global active count (telemetry only; does not cross-block sessions). */
  private globalActiveTasks = 0;

  constructor(delegate: AgentExecutor, telemetry: GatewayTelemetry, options: QueueingExecutorOptions, defaultAgentId = "main") {
    this.delegate = delegate;
    this.telemetry = telemetry;
    this.defaultAgentId = defaultAgentId;
    this.options = {
      maxConcurrentTasks: Math.max(1, options.maxConcurrentTasks),
      maxQueuedTasks: Math.max(0, options.maxQueuedTasks),
      saturation: options.saturation,
    };
  }

  execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sessionKey = sessionKeyFromContext(requestContext);
      const lane = this.getOrCreateLane(sessionKey);
      const entry: QueuedTaskEntry = {
        requestContext,
        eventBus,
        resolve,
        reject,
      };

      this.pendingByTaskId.set(requestContext.taskId, { entry, sessionKey });

      // Interrupt / tool-approval ack must run immediately even if the session
      // lane is full — otherwise cancel/HITL wait behind the turn they control.
      if (isSessionQueueBypassMessage(requestContext)) {
        void this.runEntry(lane, entry, { bypassConcurrency: true });
        return;
      }

      if (lane.activeTasks < this.options.maxConcurrentTasks) {
        // Reserve the slot synchronously to avoid a race where two execute()
        // calls both see activeTasks < max before either increments.
        lane.activeTasks += 1;
        void this.runEntry(lane, entry, { reserved: true });
        return;
      }

      if (lane.queue.length >= this.options.maxQueuedTasks) {
        this.pendingByTaskId.delete(requestContext.taskId);
        this.telemetry.recordQueueRejected(
          requestContext.taskId,
          requestContext.contextId,
          lane.queue.length,
        );
        eventBus.publish(
          taskEvent(
            requestContext.taskId,
            requestContext.contextId,
            TaskState.TASK_STATE_REJECTED,
            "Session queue limit reached",
          ),
        );
        eventBus.finished();
        resolve();
        return;
      }

      lane.queue.push(entry);
      this.telemetry.recordTaskQueued(
        requestContext.taskId,
        requestContext.contextId,
        lane.queue.length,
        this.totalQueued(),
      );
      const queuedTask = buildTask(
        requestContext.taskId,
        requestContext.contextId,
        TaskState.TASK_STATE_SUBMITTED,
        {
          statusMessage: statusMessage(
            requestContext.contextId,
            `Queued for execution in session (position ${lane.queue.length})`,
            requestContext.taskId,
          ),
        },
      );
      eventBus.publish(
        AgentEvent.task(queuedTask),
      );
    });
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const pending = this.pendingByTaskId.get(taskId);
    if (pending) {
      const lane = this.lanes.get(pending.sessionKey);
      const queuedIndex = lane?.queue.findIndex((entry) => entry.requestContext.taskId === taskId) ?? -1;
      if (lane && queuedIndex !== -1) {
        const [entry] = lane.queue.splice(queuedIndex, 1);
        if (entry) {
          this.pendingByTaskId.delete(taskId);
          publishStatusUpdate(
            entry.eventBus,
            taskId,
            entry.requestContext.contextId,
            TaskState.TASK_STATE_CANCELED,
            {
              statusMessage: statusMessage(
                entry.requestContext.contextId,
                "Task canceled while queued",
                taskId,
              ),
            },
          );
          entry.eventBus.finished();
          entry.resolve();
          this.telemetry.recordTaskFinish(
            taskId,
            entry.requestContext.contextId,
            "canceled",
            0,
            this.globalActiveTasks,
            this.totalQueued(),
          );
          this.maybeDropLane(lane);
        }
        return;
      }
    }

    await this.delegate.cancelTask(taskId, eventBus);
  }

  private getOrCreateLane(sessionKey: string): SessionLane {
    let lane = this.lanes.get(sessionKey);
    if (!lane) {
      lane = { sessionKey, queue: [], activeTasks: 0 };
      this.lanes.set(sessionKey, lane);
    }
    return lane;
  }

  private maybeDropLane(lane: SessionLane): void {
    if (lane.activeTasks === 0 && lane.queue.length === 0) {
      this.lanes.delete(lane.sessionKey);
    }
  }

  private totalQueued(): number {
    let total = 0;
    for (const sessionLane of this.lanes.values()) {
      total += sessionLane.queue.length;
    }
    return total;
  }

  private async runEntry(
    lane: SessionLane,
    entry: QueuedTaskEntry,
    opts: { reserved?: boolean; bypassConcurrency?: boolean } = {},
  ): Promise<void> {
    const { requestContext } = entry;
    const startedAt = Date.now();
    let finalState: TerminalTaskState | undefined;
    let finalErrorMessage: string | undefined;
    const countsTowardLimit = !opts.bypassConcurrency;

    this.queueDelete(lane, requestContext.taskId);

    if (countsTowardLimit && !opts.reserved) {
      lane.activeTasks += 1;
    }

    // Soft concurrency delay based on this session's load (after reservation).
    if (countsTowardLimit && this.options.saturation) {
      const delayMs = computeSaturationDelay(
        Math.max(0, lane.activeTasks - 1),
        this.options.maxConcurrentTasks,
        this.options.saturation,
      );
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    this.globalActiveTasks += 1;
    this.telemetry.recordTaskStart(
      requestContext.taskId,
      requestContext.contextId,
      this.pickAgentId(requestContext),
      this.globalActiveTasks,
      this.totalQueued(),
    );

    const observedBus = createObservedEventBus(entry.eventBus, (event) => {
      const status = resolveTerminalStatus(event);
      if (!status) {
        return;
      }
      const label = terminalStateLabel(status.state);
      if (!label) {
        return;
      }
      finalState = label;
      if (label !== "completed") {
        finalErrorMessage = partText(status.message?.parts?.[0]) ?? finalErrorMessage;
      }
    });

    try {
      await this.delegate.execute(requestContext, observedBus);
      entry.resolve();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      finalState = finalState || "failed";
      finalErrorMessage = finalErrorMessage || message;
      entry.reject(error instanceof Error ? error : new Error(message));
      return;
    } finally {
      this.pendingByTaskId.delete(requestContext.taskId);
      if (countsTowardLimit) {
        lane.activeTasks = Math.max(0, lane.activeTasks - 1);
      }
      this.globalActiveTasks = Math.max(0, this.globalActiveTasks - 1);

      this.telemetry.recordTaskFinish(
        requestContext.taskId,
        requestContext.contextId,
        finalState || "failed",
        Date.now() - startedAt,
        this.globalActiveTasks,
        this.totalQueued(),
        finalErrorMessage,
      );

      // Ensure eventBus.finished() is always called so the SDK's
      // DefaultRequestHandler does not hang waiting for the signal.
      try {
        entry.eventBus.finished();
      } catch {
        // already finished — safe to ignore
      }

      this.drainLane(lane);
      this.maybeDropLane(lane);
    }
  }

  private drainLane(lane: SessionLane): void {
    while (lane.activeTasks < this.options.maxConcurrentTasks && lane.queue.length > 0) {
      const next = lane.queue.shift();
      if (!next) {
        break;
      }
      // Reserve before spawning async work so the while-condition stays correct.
      lane.activeTasks += 1;
      void this.runEntry(lane, next, { reserved: true });
    }
  }

  private queueDelete(lane: SessionLane, taskId: string): void {
    const index = lane.queue.findIndex((entry) => entry.requestContext.taskId === taskId);
    if (index !== -1) {
      lane.queue.splice(index, 1);
    }
  }

  private pickAgentId(requestContext: RequestContext): string {
    const message = requestContext.userMessage as unknown as Record<string, unknown> | undefined;
    const metadata = message && typeof message.metadata === "object" && message.metadata
      ? (message.metadata as Record<string, unknown>)
      : undefined;
    if (typeof message?.agentName === "string") {
      return message.agentName;
    }
    if (typeof message?.agentId === "string") {
      return message.agentId;
    }
    if (typeof metadata?.agentName === "string") {
      return metadata.agentName;
    }
    if (typeof metadata?.agentId === "string") {
      return metadata.agentId;
    }
    return this.defaultAgentId;
  }
}
