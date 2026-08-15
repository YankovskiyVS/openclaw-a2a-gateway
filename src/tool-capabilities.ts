import { createHash } from "node:crypto";

export type ToolCapabilityKind =
  | "passive"
  | "mutation"
  | "destructive"
  | "externalCommunication"
  | "resourceCreation"
  | "unknown";

export type ToolCapability = {
  kind: ToolCapabilityKind;
  toolFamily: string;
  reason: string;
  requiresApproval: boolean;
};

const PASSIVE = new Set([
  "nango_list_connections",
  "nango_yandex_disk_info", "nango_yandex_disk_list", "nango_yandex_disk_get",
  "nango_yandex_disk_files", "nango_yandex_disk_last_uploaded",
  "nango_yandex_disk_download_link", "nango_yandex_disk_trash_list",
  "nango_yandex_mail_list", "nango_yandex_mail_get",
  "nango_yandex_calendar_list_calendars", "nango_yandex_calendar_list_events",
  "nango_yandex_calendar_get_event", "read", "web_fetch", "web_search",
  "sessions_list", "sessions_history", "session_status",
]);
const EXTERNAL = new Set(["nango_yandex_mail_send", "sessions_send"]);
const RESOURCE = new Set([
  "sessions_spawn", "nango_yandex_disk_mkdir",
  "nango_yandex_calendar_create_calendar", "nango_yandex_calendar_create_event",
]);
const DESTRUCTIVE = new Set([
  "nango_yandex_disk_delete", "nango_yandex_disk_trash_empty",
  "nango_yandex_calendar_delete_event",
]);

function family(name: string): string {
  if (name.startsWith("nango_yandex_mail_")) return "nango_mail";
  if (name.startsWith("nango_yandex_disk_")) return "nango_disk";
  if (name.startsWith("nango_yandex_calendar_")) return "nango_calendar";
  if (name.startsWith("nango_")) return "nango";
  if (name.startsWith("sessions_") || name === "session_status") return "session";
  if (["read", "write", "edit", "apply_patch"].includes(name)) return "filesystem";
  if (name.startsWith("web_")) return "web";
  return "unknown";
}

function capability(kind: ToolCapabilityKind, name: string, reason: string): ToolCapability {
  return Object.freeze({ kind, toolFamily: family(name), reason, requiresApproval: kind !== "passive" });
}

export function classifyToolCapability(
  toolName: string,
  params: Record<string, unknown> = {},
): ToolCapability {
  const name = toolName.trim();
  if (PASSIVE.has(name) || (name.startsWith("nango_") && /_(?:list|list_[a-z0-9_]+|get|get_[a-z0-9_]+|read|search|info|files|last_uploaded|download_link)$/.test(name))) {
    return capability("passive", name, "known_read_only_tool");
  }
  if (name.startsWith("nango_") && name.endsWith("_call")) {
    const method = typeof params.method === "string" ? params.method.trim().toUpperCase() : "GET";
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return capability("passive", name, "nango_read_method");
    if (method === "DELETE") return capability("destructive", name, "nango_delete_method");
    if (["POST", "PUT", "PATCH"].includes(method)) return capability("mutation", name, "nango_write_method");
  }
  if (EXTERNAL.has(name)) return capability("externalCommunication", name, "known_external_communication");
  if (RESOURCE.has(name)) return capability("resourceCreation", name, "known_resource_creation");
  if (DESTRUCTIVE.has(name) || /_(?:delete|remove|trash_empty)$/.test(name)) {
    return capability("destructive", name, "known_destructive_tool");
  }
  if (["write", "edit", "apply_patch"].includes(name)
    || /_(?:upload|upload_link|copy|move|publish|unpublish|trash_restore|update_event)$/.test(name)) {
    return capability("mutation", name, "known_mutation_tool");
  }
  return capability("unknown", name, "unknown_tool_semantics");
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new TypeError("unsupported action value");
}

export function computeActionHash(input: {
  userTurnId: string;
  toolName: string;
  params: Record<string, unknown>;
  sessionKey?: string;
  contextId?: string;
}): string {
  const normalized = canonical({
    userTurnId: input.userTurnId,
    toolName: input.toolName,
    params: input.params,
    sessionKey: input.sessionKey ?? null,
    contextId: input.contextId ?? null,
  });
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}
