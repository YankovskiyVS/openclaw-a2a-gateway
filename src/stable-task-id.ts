import { TaskState } from "@a2a-js/sdk";

const MESSAGE_DEDUP_TTL_MS = 30 * 60_000;
const MESSAGE_DEDUP_MAX_ENTRIES = 10_000;

type StoredTask = {
  id?: string;
  history?: Array<{ messageId?: string }>;
};

type DedupEntry = {
  promise: Promise<unknown>;
  expiresAt: number;
};

type StableTaskHandler = Record<string, unknown> & {
  __openclawStableTaskIdPatched?: boolean;
  __openclawMessageDedup?: Map<string, DedupEntry>;
  _createRequestContext?: (
    request: { message?: Record<string, unknown> },
    context: unknown,
  ) => Promise<unknown>;
  sendMessage?: (
    request: { message?: Record<string, unknown> },
    context: unknown,
  ) => Promise<unknown>;
  taskStore?: {
    load: (id: string, context: unknown) => Promise<StoredTask | undefined>;
    save: (task: unknown, context: unknown) => Promise<void>;
  };
};

/**
 * Patch DefaultRequestHandler so a new task uses message.messageId as its
 * taskId when the client omitted taskId. The same messageId is also treated
 * as an idempotency key: concurrent retries share one send promise, while a
 * retry after completion (or process restart) returns the persisted task.
 *
 * The stock SDK does `taskId = message.taskId || uuidv4()` and throws
 * TaskNotFoundError if a client-supplied taskId is missing from the store.
 * We pre-seed a stub task for brand-new messageIds before delegating.
 */
export function installStableTaskIds(DefaultRequestHandler: {
  prototype: object;
}): boolean {
  const proto = DefaultRequestHandler.prototype as StableTaskHandler;
  if (proto.__openclawStableTaskIdPatched) {
    return true;
  }
  const originalCreateRequestContext = proto._createRequestContext;
  const originalSendMessage = proto.sendMessage;
  if (typeof originalCreateRequestContext !== "function") {
    return false;
  }

  proto._createRequestContext = async function patchedCreateRequestContext(
    this: StableTaskHandler,
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
    return originalCreateRequestContext.call(this, request, context);
  };

  if (typeof originalSendMessage === "function") {
    proto.sendMessage = function idempotentSendMessage(
      this: StableTaskHandler,
      request: { message?: Record<string, unknown> },
      context: unknown,
    ): Promise<unknown> {
      const messageId = typeof request?.message?.messageId === "string"
        ? request.message.messageId.trim()
        : "";
      if (!messageId || !this.taskStore) {
        return originalSendMessage.call(this, request, context);
      }

      const tenant = context && typeof context === "object" && "tenant" in context
        ? String((context as { tenant?: unknown }).tenant ?? "")
        : "";
      const dedupKey = `${tenant}\u0000${messageId}`;
      const now = Date.now();
      const entries = this.__openclawMessageDedup ??= new Map<string, DedupEntry>();

      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
      }
      const duplicate = entries.get(dedupKey);
      if (duplicate) {
        return duplicate.promise.then(async (result) => {
          const stored = await this.taskStore?.load(messageId, context);
          return stored ?? result;
        });
      }

      const promise = Promise.resolve().then(async () => {
        const stored = await this.taskStore?.load(messageId, context);
        const alreadyAccepted = stored?.history?.some((message) => message.messageId === messageId);
        if (stored && alreadyAccepted) return stored;
        return originalSendMessage.call(this, request, context);
      });
      const entry: DedupEntry = { promise, expiresAt: now + MESSAGE_DEDUP_TTL_MS };
      entries.set(dedupKey, entry);

      while (entries.size > MESSAGE_DEDUP_MAX_ENTRIES) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (!oldestKey) break;
        entries.delete(oldestKey);
      }

      void promise.then(
        () => { entry.expiresAt = Date.now() + MESSAGE_DEDUP_TTL_MS; },
        () => {
          if (entries.get(dedupKey) === entry) entries.delete(dedupKey);
        },
      );
      return promise;
    };
  }

  proto.__openclawStableTaskIdPatched = true;
  return true;
}
