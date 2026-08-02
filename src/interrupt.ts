/**
 * A2A interrupt/stop signal — mirrors toolApproval metadata pattern.
 *
 * Clients send an empty-text user message with metadata.interrupt to stop
 * the active agent run for the same contextId (chat session).
 */
export interface InterruptSignal {
  reason?: string;
  runId?: string;
  taskId?: string;
}

const INTERRUPT_METADATA_KEYS = ["interrupt", "abort", "stop"] as const;

export function extractInterruptSignal(message: unknown): InterruptSignal | undefined {
  const msg = asObject(message);
  const metadata = asObject(msg?.metadata);
  if (!metadata) {
    return undefined;
  }

  for (const key of INTERRUPT_METADATA_KEYS) {
    const raw = metadata[key];
    if (raw === true) {
      return { reason: key };
    }
    const obj = asObject(raw);
    if (!obj) {
      continue;
    }
    return {
      reason: asString(obj.reason) ?? key,
      runId: asString(obj.runId) ?? asString(obj.run_id),
      taskId: asString(obj.taskId) ?? asString(obj.task_id),
    };
  }
  return undefined;
}

export function isInterruptOnlyMessage(message: unknown): boolean {
  const signal = extractInterruptSignal(message);
  if (!signal) {
    return false;
  }
  return extractMessageText(message) === "";
}

function extractMessageText(message: unknown): string {
  const msg = asObject(message);
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const texts: string[] = [];
  for (const part of parts) {
    const obj = asObject(part);
    const content = asObject(obj?.content);
    if (content?.$case === "text" && typeof content.value === "string") {
      const trimmed = content.value.trim();
      if (trimmed) {
        texts.push(trimmed);
      }
    } else if (typeof obj?.text === "string" && obj.text.trim()) {
      texts.push(obj.text.trim());
    }
  }
  return texts.join("\n").trim();
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
