/**
 * Map OpenClaw `agent` / `agent.wait` terminal payloads to a failure message.
 * Status "ok" with an explicit error string still fails (surface_error paths).
 */

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function agentRunFailureMessage(payload: unknown): string | undefined {
  const body = asObject(payload);
  if (!body) {
    return undefined;
  }
  const result = asObject(body.result);
  const status = asString(body.status) || asString(result?.status);
  const error =
    asString(body.error) ||
    asString(result?.error) ||
    asString(body.summary);
  const stopReason = asString(body.stopReason) || asString(result?.stopReason);

  if (status === "timeout" || status === "error") {
    return error || (status === "timeout" ? "Agent run timed out" : "Agent run failed");
  }
  if (status && status !== "ok") {
    return error || `Agent run did not complete (status=${status})`;
  }
  if (error && /timeout|surface_error|failover|timed out/i.test(error)) {
    return error;
  }
  if (stopReason && /error|timeout|fail/i.test(stopReason) && error) {
    return error;
  }
  return undefined;
}
