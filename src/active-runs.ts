/**
 * Registry of in-flight A2A agent runs so cancelTask / metadata.interrupt
 * can abort the OpenClaw agent and finish the live event bus cleanly.
 */
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import { TaskState } from "@a2a-js/sdk";

import { agentMessage, publishStatusUpdate, textPart } from "./a2a/helpers.js";

export class RunCanceledError extends Error {
  constructor(message = "Agent run canceled") {
    super(message);
    this.name = "RunCanceledError";
  }
}

export type ActiveRun = {
  taskId: string;
  contextId: string;
  sessionKey: string;
  runId: string;
  eventBus: ExecutionEventBus;
  abortController: AbortController;
  /** Optional: close gateway WS / reject pending RPC. */
  closeGateway?: () => void;
  /** Optional: best-effort chat.abort on the live gateway connection. */
  requestChatAbort?: () => Promise<void>;
  canceled: boolean;
  finished: boolean;
};

export class ActiveRunRegistry {
  private readonly byTaskId = new Map<string, ActiveRun>();
  /** contextId may have multiple concurrent runs when maxConcurrentTasks > 1. */
  private readonly byContextId = new Map<string, Set<string>>();
  private readonly bySessionKey = new Map<string, Set<string>>();
  private readonly byRunId = new Map<string, ActiveRun>();

  register(run: ActiveRun): void {
    const existing = this.byTaskId.get(run.taskId);
    if (existing && existing.runId !== run.runId) {
      this.byRunId.delete(existing.runId);
    }
    this.byTaskId.set(run.taskId, run);
    this.byRunId.set(run.runId, run);
    this.addToIndex(this.byContextId, run.contextId, run.taskId);
    this.addToIndex(this.bySessionKey, run.sessionKey, run.taskId);
  }

  unregister(taskId: string): void {
    const run = this.byTaskId.get(taskId);
    if (!run) {
      return;
    }
    this.byTaskId.delete(taskId);
    this.byRunId.delete(run.runId);
    this.removeFromIndex(this.byContextId, run.contextId, taskId);
    this.removeFromIndex(this.bySessionKey, run.sessionKey, taskId);
  }

  getByTaskId(taskId: string): ActiveRun | undefined {
    return this.byTaskId.get(taskId);
  }

  find(opts: {
    taskId?: string;
    contextId?: string;
    sessionKey?: string;
    runId?: string;
  }): ActiveRun | undefined {
    const all = this.findAll(opts);
    return all[all.length - 1];
  }

  /** All matching active runs (for context/session interrupt without taskId). */
  findAll(opts: {
    taskId?: string;
    contextId?: string;
    sessionKey?: string;
    runId?: string;
  }): ActiveRun[] {
    if (opts.taskId) {
      const byTask = this.byTaskId.get(opts.taskId);
      return byTask ? [byTask] : [];
    }
    if (opts.runId) {
      const byRun = this.byRunId.get(opts.runId);
      return byRun ? [byRun] : [];
    }
    if (opts.sessionKey) {
      return this.runsFromIndex(this.bySessionKey.get(opts.sessionKey));
    }
    if (opts.contextId) {
      return this.runsFromIndex(this.byContextId.get(opts.contextId));
    }
    return [];
  }

  /**
   * Abort an active run: signal AbortController, stop OpenClaw agent,
   * publish TASK_STATE_CANCELED on the live bus once.
   */
  async interrupt(
    run: ActiveRun,
    statusMessage = "Stopped by user",
    abortOpenClaw?: (sessionKey: string, runId: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (run.canceled) {
      return true;
    }
    run.canceled = true;

    try {
      if (run.requestChatAbort) {
        await run.requestChatAbort();
      }
    } catch {
      // best-effort
    }

    if (abortOpenClaw) {
      try {
        await abortOpenClaw(run.sessionKey, run.runId);
      } catch {
        // best-effort
      }
    }

    try {
      run.abortController.abort(new RunCanceledError(statusMessage));
    } catch {
      // ignore
    }

    try {
      run.closeGateway?.();
    } catch {
      // ignore
    }

    if (!run.finished) {
      run.finished = true;
      publishStatusUpdate(run.eventBus, run.taskId, run.contextId, TaskState.TASK_STATE_CANCELED, {
        statusMessage: agentMessage(run.contextId, [textPart(statusMessage)], run.taskId),
      });
      run.eventBus.finished();
    }

    // Keep the entry until the owning execute() path unregisters it.
    // Otherwise a racing dispatch can miss canceled/finished and publish COMPLETED.
    return true;
  }

  private addToIndex(index: Map<string, Set<string>>, key: string, taskId: string): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(taskId);
  }

  private removeFromIndex(index: Map<string, Set<string>>, key: string, taskId: string): void {
    const set = index.get(key);
    if (!set) {
      return;
    }
    set.delete(taskId);
    if (set.size === 0) {
      index.delete(key);
    }
  }

  private runsFromIndex(taskIds: Set<string> | undefined): ActiveRun[] {
    if (!taskIds || taskIds.size === 0) {
      return [];
    }
    const runs: ActiveRun[] = [];
    for (const taskId of taskIds) {
      const run = this.byTaskId.get(taskId);
      if (run) {
        runs.push(run);
      }
    }
    return runs;
  }
}

export const activeRuns = new ActiveRunRegistry();

/**
 * Best-effort abort of the embedded OpenClaw agent for a sessionKey.
 * Uses dynamic imports so the plugin stays type-only coupled at build time.
 */
export async function abortOpenClawAgent(sessionKey: string, runId?: string): Promise<boolean> {
  let aborted = false;

  // Prefer run-scoped abort when multiple A2A tasks share one OpenClaw session.
  const peers = activeRuns.findAll({ sessionKey });
  const multiPeer = peers.length > 1;

  if (runId) {
    try {
      const runtime = (globalThis as { openclaw?: { abortRun?: (id: string) => boolean } }).openclaw;
      if (runtime?.abortRun) {
        aborted = Boolean(runtime.abortRun(runId));
      }
    } catch {
      // ignore
    }
  }

  // OpenClaw 2026.7 removed the former private plugin-sdk session/runner
  // entrypoints. The public run-scoped abort above plus the live chat.abort
  // request owned by ActiveRunRegistry are the supported cancellation paths.
  // Never fall back to a session-wide abort when sibling runs share a session.
  if (multiPeer) {
    return aborted;
  }

  return aborted;
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RunCanceledError) return true;
  if (err instanceof Error) {
    // AbortSignal.timeout() → TimeoutError / "aborted due to timeout" must stay FAILED.
    if (err.name === "TimeoutError") return false;
    if (/due to timeout/i.test(err.message)) return false;
    // Lifecycle/surface_error fail-fast must publish TASK_STATE_FAILED, not cancel.
    if (/agent run timed out|agent run failed|surface_error/i.test(err.message)) {
      return false;
    }
    if (err.name === "AbortError" || err.name === "RunCanceledError") return true;
    if (/aborted|canceled|cancelled/i.test(err.message)) return true;
  }
  return false;
}
