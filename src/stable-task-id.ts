import { TaskState } from "@a2a-js/sdk";

/**
 * Patch DefaultRequestHandler so a new task uses message.messageId as its
 * taskId when the client omitted taskId. Manager sends user message id as
 * messageId — retries then hit the same task instead of enqueueing duplicates.
 *
 * The stock SDK does `taskId = message.taskId || uuidv4()` and throws
 * TaskNotFoundError if a client-supplied taskId is missing from the store.
 * We pre-seed a stub task for brand-new messageIds before delegating.
 */
export function installStableTaskIds(DefaultRequestHandler: {
  prototype: Record<string, unknown>;
}): boolean {
  const proto = DefaultRequestHandler.prototype as Record<string, unknown> & {
    __openclawStableTaskIdPatched?: boolean;
    _createRequestContext?: (request: unknown, context: unknown) => Promise<unknown>;
    taskStore?: {
      load: (id: string, context: unknown) => Promise<{ history?: Array<{ messageId?: string }> } | undefined>;
      save: (task: unknown, context: unknown) => Promise<void>;
    };
  };
  if (proto.__openclawStableTaskIdPatched) {
    return true;
  }
  const original = proto._createRequestContext;
  if (typeof original !== "function") {
    return false;
  }

  proto._createRequestContext = async function patchedCreateRequestContext(
    this: typeof proto,
    request: { message?: Record<string, unknown> },
    context: unknown,
  ) {
    const msg = request?.message;
    if (msg && typeof msg === "object") {
      const messageId = typeof msg.messageId === "string" ? msg.messageId.trim() : "";
      const existingTaskId = typeof msg.taskId === "string" ? msg.taskId.trim() : "";
      if (!existingTaskId && messageId && this.taskStore) {
        const existing = await this.taskStore.load(messageId, context);
        if (!existing) {
          await this.taskStore.save(
            {
              kind: "task",
              id: messageId,
              contextId: typeof msg.contextId === "string" ? msg.contextId : "",
              status: { state: TaskState.TASK_STATE_SUBMITTED },
              history: [],
              artifacts: [],
            },
            context,
          );
        }
        msg.taskId = messageId;
      }
    }
    return original.call(this, request, context);
  };

  proto.__openclawStableTaskIdPatched = true;
  return true;
}
