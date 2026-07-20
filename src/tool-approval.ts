export type ToolApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface ToolApprovalDecisionPayload {
  approvalId: string;
  callId?: string;
  decision: ToolApprovalDecision;
}

export interface ExecApprovalRequestPayload {
  id: string;
  expiresAtMs?: number;
  request?: {
    sessionKey?: string;
    command?: string;
    cwd?: string;
    agentId?: string;
    toolCallId?: string;
    toolName?: string;
  };
}

const TOOL_APPROVAL_METADATA_KEY = "toolApproval";

export function extractToolApprovalDecision(message: unknown): ToolApprovalDecisionPayload | undefined {
  const msg = asObject(message);
  const metadata = asObject(msg?.metadata);
  const raw = asObject(metadata?.[TOOL_APPROVAL_METADATA_KEY]) ?? asObject(metadata?.tool_approval);
  if (!raw) {
    return undefined;
  }
  const approvalId = asString(raw.approvalId) ?? asString(raw.approval_id);
  const decision = normalizeDecision(asString(raw.decision));
  if (!approvalId || !decision) {
    return undefined;
  }
  return {
    approvalId,
    callId: asString(raw.callId) ?? asString(raw.call_id),
    decision,
  };
}

export function isToolApprovalOnlyMessage(message: unknown): boolean {
  const decision = extractToolApprovalDecision(message);
  if (!decision) {
    return false;
  }
  const text = extractMessageText(message);
  return text === "";
}

function normalizeDecision(value: string | undefined): ToolApprovalDecision | undefined {
  switch (value?.trim().toLowerCase()) {
    case "allow-once":
    case "allow_once":
      return "allow-once";
    case "allow-always":
    case "allow_always":
      return "allow-always";
    case "deny":
    case "reject":
    case "reject-once":
    case "reject_once":
      return "deny";
    default:
      return undefined;
  }
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

export function toolStatusFromPhase(
  phase: string,
  toolApprovalEnabled: boolean,
  isError?: boolean,
): string | undefined {
  if (!toolApprovalEnabled) {
    return undefined;
  }
  switch (phase) {
    case "start":
      return "pending_approval";
    case "update":
      return "running";
    case "result":
      if (isError) {
        return "failed";
      }
      return "completed";
    default:
      return undefined;
  }
}

export function execApprovalToolName(request: ExecApprovalRequestPayload): string {
  const req = request.request;
  return asString(req?.toolName) ?? "exec";
}

export function execApprovalCallId(request: ExecApprovalRequestPayload): string {
  const req = request.request;
  return asString(req?.toolCallId) ?? request.id;
}
