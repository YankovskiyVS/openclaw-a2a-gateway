import type { StreamResponse } from "@a2a-js/sdk";
import { TaskState } from "@a2a-js/sdk";

const MESSAGE_DEDUP_TTL_MS = 30 * 60_000;
const MESSAGE_DEDUP_MAX_ENTRIES = 10_000;

type StoredTask = {
  id?: string;
  kind?: string;
  contextId?: string;
  status?: unknown;
  artifacts?: unknown[];
  metadata?: unknown;
  history?: Array<{ messageId?: string }>;
};

type DedupEntry = {
  promise: Promise<unknown>;
  first: Promise<unknown>;
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
  sendMessageStream?: (
    request: { message?: Record<string, unknown> },
    context: unknown,
  ) => AsyncGenerator<StreamResponse, void, undefined>;
  taskStore?: {
    load: (id: string, context: unknown) => Promise<StoredTask | undefined>;
    save: (task: unknown, context: unknown) => Promise<void>;
  };
};

function createDeferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function taskIdFor(
  request: { message?: Record<string, unknown> },
  messageId: string,
): string {
  const explicit = typeof request.message?.taskId === "string"
    ? request.message.taskId.trim()
    : "";
  return explicit || messageId;
}

function asTaskStreamResponse(task: StoredTask): StreamResponse {
  return {
    payload: {
      $case: "task",
      value: task,
    },
  } as StreamResponse;
}

function isAccepted(task: StoredTask | undefined, messageId: string): boolean {
  return task?.history?.some((message) => message.messageId === messageId) === true;
}

/**
 * Patch DefaultRequestHandler so a new task uses message.messageId as its
 * taskId when the client omitted taskId. The same messageId is also treated
 * as an idempotency key: concurrent send/stream retries share one execution,
 * while a retry after completion (or process restart) returns the persisted task.
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
  const originalSendMessageStream = proto.sendMessageStream;
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
          const stored = await this.taskStore?.load(taskIdFor(request, messageId), context);
          return stored ?? result;
        });
      }

      const promise = Promise.resolve().then(async () => {
        const stored = await this.taskStore?.load(taskIdFor(request, messageId), context);
        if (stored && isAccepted(stored, messageId)) return stored;
        return originalSendMessage.call(this, request, context);
      });
      const entry: DedupEntry = { promise, first: promise, expiresAt: now + MESSAGE_DEDUP_TTL_MS };
      entries.set(dedupKey, entry);

      while (entries.size > MESSAGE_DEDUP_MAX_ENTRIES) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (!oldestKey) break;
        entries.delete(oldestKey);
      }

      void promise.then(
        () => { entry.expiresAt = Date.now() + MESSAGE_DEDUP_TTL_MS; },
        () => {
          // Keep the claim: executor can outlive a failed client transport.
          entry.expiresAt = Date.now() + MESSAGE_DEDUP_TTL_MS;
        },
      );
      return promise;
    };
  }
  if (typeof originalSendMessageStream === "function") {
    proto.sendMessageStream = function idempotentSendMessageStream(
      this: StableTaskHandler,
      request: { message?: Record<string, unknown> },
      context: unknown,
    ): AsyncGenerator<StreamResponse, void, undefined> {
      const messageId = typeof request?.message?.messageId === "string"
        ? request.message.messageId.trim()
        : "";
      if (!messageId || !this.taskStore) {
        return originalSendMessageStream.call(this, request, context);
      }

      const tenant = context && typeof context === "object" && "tenant" in context
        ? String((context as { tenant?: unknown }).tenant ?? "")
        : "";
      const dedupKey = `${tenant}\u0000${messageId}`;
      const taskId = taskIdFor(request, messageId);
      const now = Date.now();
      const entries = this.__openclawMessageDedup ??= new Map<string, DedupEntry>();

      for (const [key, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(key);
      }

      const duplicate = entries.get(dedupKey);
      if (duplicate) {
        const handler = this;
        return (async function* duplicateTaskSnapshot() {
          const first = await duplicate.first;
          const stored = await handler.taskStore?.load(taskId, context);
          if (stored) {
            yield asTaskStreamResponse(stored);
            return;
          }
          if (first && typeof first === "object" && "payload" in first) {
            yield first as StreamResponse;
          }
        })();
      }

      // Claim ownership synchronously before async generator execution starts.
      const first = createDeferred();
      const completion = createDeferred();
      const entry: DedupEntry = {
        first: first.promise,
        promise: completion.promise,
        expiresAt: now + MESSAGE_DEDUP_TTL_MS,
      };
      entries.set(dedupKey, entry);
      while (entries.size > MESSAGE_DEDUP_MAX_ENTRIES) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (!oldestKey) break;
        entries.delete(oldestKey);
      }

      const handler = this;
      return (async function* ownerStream() {
        let last: StreamResponse | undefined;
        try {
          const stored = await handler.taskStore?.load(taskId, context);
          if (stored && isAccepted(stored, messageId)) {
            const response = asTaskStreamResponse(stored);
            first.resolve(response);
            completion.resolve(response);
            yield response;
            return;
          }

          for await (const response of originalSendMessageStream.call(handler, request, context)) {
            last = response;
            first.resolve(response);
            yield response;
          }

          const latest = await handler.taskStore?.load(taskId, context);
          const result = latest ? asTaskStreamResponse(latest) : last;
          first.resolve(result);
          completion.resolve(result);
        } catch (error) {
          const latest = await handler.taskStore?.load(taskId, context);
          const result = latest ? asTaskStreamResponse(latest) : last;
          first.resolve(result);
          completion.resolve(result);
          throw error;
        } finally {
          entry.expiresAt = Date.now() + MESSAGE_DEDUP_TTL_MS;
        }
      })();
    };
  }


  proto.__openclawStableTaskIdPatched = true;
  return true;
}
