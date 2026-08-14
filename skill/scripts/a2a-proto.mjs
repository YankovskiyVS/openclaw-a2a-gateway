import { Role, TaskState } from "@a2a-js/sdk";

export { Role };

export function textPart(text) {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "",
  };
}

export function rawPart(bytes, mediaType, filename) {
  return {
    content: { $case: "raw", value: bytes },
    metadata: undefined,
    filename,
    mediaType,
  };
}

export function urlPart(url) {
  return {
    content: { $case: "url", value: url },
    metadata: undefined,
    filename: "",
    mediaType: "",
  };
}

export function extractTextParts(parts) {
  if (!Array.isArray(parts)) return undefined;

  const chunks = [];
  for (const part of parts) {
    if (part?.content?.$case === "text" && typeof part.content.value === "string") {
      chunks.push(part.content.value);
    } else if (part?.kind === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    } else if (typeof part?.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.length > 0 ? chunks.join("") : undefined;
}

const TASK_STATE_NAMES = new Map([
  [TaskState.TASK_STATE_UNSPECIFIED, "unknown"],
  [TaskState.TASK_STATE_SUBMITTED, "submitted"],
  [TaskState.TASK_STATE_WORKING, "working"],
  [TaskState.TASK_STATE_COMPLETED, "completed"],
  [TaskState.TASK_STATE_FAILED, "failed"],
  [TaskState.TASK_STATE_CANCELED, "canceled"],
  [TaskState.TASK_STATE_INPUT_REQUIRED, "input-required"],
  [TaskState.TASK_STATE_REJECTED, "rejected"],
  [TaskState.TASK_STATE_AUTH_REQUIRED, "auth-required"],
]);

export function taskResponseText(task) {
  const candidates = [extractTextParts(task?.status?.message?.parts) || ""];
  for (const artifact of task?.artifacts || []) {
    candidates.push(extractTextParts(artifact?.parts) || "");
  }
  return candidates.reduce((longest, candidate) =>
    candidate.length > longest.length ? candidate : longest, "");
}

export function normalizeTaskState(state) {
  if (typeof state === "number") return TASK_STATE_NAMES.get(state) || "unknown";
  if (typeof state !== "string" || !state) return "unknown";

  return state
    .replace(/^TASK_STATE_/, "")
    .toLowerCase()
    .replaceAll("_", "-");
}

export function isTask(value) {
  return Boolean(value && typeof value === "object" && typeof value.id === "string" && value.status);
}

export function isMessage(value) {
  return Boolean(value && typeof value === "object" && typeof value.messageId === "string" && Array.isArray(value.parts));
}
