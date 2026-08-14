import { v4 as uuidv4 } from "uuid";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
  type AuthenticationHandler,
  type HttpHeaders,
  type RequestOptions,
} from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import type { AgentCard, Message, SendMessageRequest } from "@a2a-js/sdk";
import { Role } from "@a2a-js/sdk";
import { isJsonRpcError, isRestError } from "@a2a-js/sdk/errors";

import { textPart, urlPart } from "./a2a/helpers.js";
import { ConnectionPool, type ConnectionPoolConfig } from "./connection-pool.js";
import type { OutboundSendResult, PeerConfig, RetryConfig } from "./types.js";
import type { PeerHealthManager } from "./peer-health.js";
import { withRetry } from "./peer-retry.js";
import {
  orderTransports,
  adaptiveOrderTransports,
  isRetryableTransportError,
  TransportStats,
  type TransportEndpoint,
} from "./transport-fallback.js";

const nativeFetch = globalThis.fetch;

/**
 * Build an AuthenticationHandler for bearer or apiKey auth.
 */
function createAuthHandler(peer: PeerConfig): AuthenticationHandler | undefined {
  const auth = peer.auth;
  if (!auth?.token) return undefined;

  const headerKey = auth.type === "bearer" ? "authorization" : "x-api-key";
  const headerValue = auth.type === "bearer" ? `Bearer ${auth.token}` : auth.token;

  return {
    headers: async (): Promise<HttpHeaders> => ({
      [headerKey]: headerValue,
    }),
    shouldRetryWithHeaders: async () => undefined,
  };
}

/**
 * Parse agentCardUrl into base URL and path.
 */
function parseAgentCardUrl(agentCardUrl: string): { baseUrl: string; path: string } {
  const parsed = new URL(agentCardUrl);
  return {
    baseUrl: parsed.origin,
    path: parsed.pathname,
  };
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeLegacyAgentCard(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const card = payload as Record<string, unknown>;
  if (Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0) {
    return payload;
  }

  const url = asString(card.url).trim();
  if (!url) {
    return payload;
  }
  const protocolVersion = asString(card.protocolVersion, "0.3.0");
  const rawCapabilities =
    card.capabilities && typeof card.capabilities === "object"
      ? (card.capabilities as Record<string, unknown>)
      : {};
  const rawSkills = Array.isArray(card.skills) ? card.skills : [];

  return {
    name: asString(card.name, "A2A Agent"),
    description: asString(card.description, asString(card.name, "A2A Agent")),
    supportedInterfaces: [
      {
        url,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion,
      },
    ],
    provider: undefined,
    version: asString(card.version, protocolVersion),
    capabilities: {
      streaming: rawCapabilities.streaming === true,
      pushNotifications: rawCapabilities.pushNotifications === true,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: Array.isArray(card.defaultInputModes)
      ? card.defaultInputModes.filter((mode): mode is string => typeof mode === "string")
      : ["text"],
    defaultOutputModes: Array.isArray(card.defaultOutputModes)
      ? card.defaultOutputModes.filter((mode): mode is string => typeof mode === "string")
      : ["text"],
    skills: rawSkills.map((entry, index) => {
      const skill =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      const name = asString(skill.name, asString(skill.id, `skill-${index + 1}`));
      return {
        id: asString(skill.id, `skill-${index + 1}`),
        name,
        description: asString(skill.description, name),
        tags: Array.isArray(skill.tags)
          ? skill.tags.filter((tag): tag is string => typeof tag === "string")
          : [],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      };
    }),
    signatures: [],
  };
}

async function normalizeAgentCardResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return response;
  }

  try {
    const payload = await response.clone().json();
    const normalized = normalizeLegacyAgentCard(payload);
    if (normalized === payload) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}


async function normalizeOutboundJsonRpcResponse(
  response: Response,
  requestInit?: RequestInit,
): Promise<Response> {
  if (!response.ok || typeof requestInit?.body !== "string") return response;

  try {
    const request = JSON.parse(requestInit.body) as { method?: unknown };
    if (request.method !== "SendMessage") return response;

    const envelope = await response.clone().json() as Record<string, unknown>;
    const result = envelope.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return response;
    const payload = result as Record<string, unknown>;
    if (payload.task || payload.message) return response;

    // Early v1 implementations returned a Task/Message directly, before the
    // final SendMessageResponse oneof wrapper was standardized.
    const wrapped = typeof payload.id === "string" && payload.status
      ? { task: payload }
      : typeof payload.messageId === "string" && Array.isArray(payload.parts)
        ? { message: payload }
        : undefined;
    if (!wrapped) return response;

    const headers = new Headers(response.headers);
    headers.set("content-type", "application/json");
    return new Response(JSON.stringify({ ...envelope, result: wrapped }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

function normalizeOutboundRole(role: unknown): Role | undefined {
  if (role === Role.ROLE_USER || role === Role.ROLE_AGENT) {
    return role;
  }
  if (role === "user" || role === "ROLE_USER" || role === 1) {
    return Role.ROLE_USER;
  }
  if (role === "agent" || role === "ROLE_AGENT" || role === 2) {
    return Role.ROLE_AGENT;
  }
  return undefined;
}

function normalizeOutboundParts(message: Record<string, unknown>): Message["parts"] {
  if (Array.isArray(message.parts) && message.parts.length > 0) {
    return message.parts.map((part) => normalizeOutboundPart(part));
  }
  const text = String(message.text || message.message || "");
  return [textPart(text)];
}

function normalizeOutboundPart(part: unknown): Message["parts"][number] {
  if (!part || typeof part !== "object") {
    return textPart("");
  }
  const obj = part as Record<string, unknown>;
  if (obj.content && typeof obj.content === "object") {
    return part as Message["parts"][number];
  }
  if (typeof obj.text === "string") {
    return textPart(obj.text);
  }
  if (typeof obj.url === "string") {
    const normalized = urlPart(obj.url, asString(obj.mimeType, asString(obj.mediaType, "")));
    normalized.filename = asString(obj.filename, asString(obj.name, ""));
    return normalized;
  }
  if (obj.kind === "text" && typeof obj.text === "string") {
    return textPart(obj.text);
  }
  if (obj.kind === "file") {
    const file = obj.file as Record<string, unknown> | undefined;
    const uri = file && typeof file.uri === "string" ? file.uri : "";
    if (uri) {
      const normalized = urlPart(uri, asString(file?.mimeType, ""));
      normalized.filename = asString(file?.name, "");
      return normalized;
    }
  }
  return textPart("");
}

export interface A2AClientConfig {
  poolConfig?: ConnectionPoolConfig;
  /** Deadline for Agent Card discovery and each outbound transport attempt. */
  requestTimeoutMs?: number;
  /** Successful Agent Card cache lifetime. Concurrent lookups are always coalesced. */
  agentCardCacheTtlMs?: number;
}

interface CachedAgentCard {
  card: AgentCard;
  expiresAt: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { statusCode?: unknown; status?: unknown; cause?: unknown };
  if (typeof value.statusCode === "number") return value.statusCode;
  if (typeof value.status === "number") return value.status;
  if (value.cause && value.cause !== error) return numericStatus(value.cause);
  return undefined;
}

function failureFromError(error: unknown): OutboundSendResult {
  const message = errorMessage(error);

  if (isRestError(error)) {
    return {
      ok: false,
      statusCode: error.statusCode,
      response: { error: message },
      retryable: error.statusCode === 429 || error.statusCode >= 500,
    };
  }

  if (isJsonRpcError(error)) {
    const retryable = error.envelopeCode === -32603;
    return {
      ok: false,
      statusCode: retryable ? 502 : 400,
      response: { error: message, code: error.envelopeCode, data: error.data },
      retryable,
    };
  }

  const status = numericStatus(error);
  if (status !== undefined) {
    return {
      ok: false,
      statusCode: status,
      response: { error: message },
      retryable: status === 429 || status >= 500,
    };
  }

  const timedOut =
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError");
  const retryable = timedOut || isRetryableTransportError(error);
  return {
    ok: false,
    statusCode: timedOut ? 504 : retryable ? 503 : 500,
    response: { error: message },
    retryable,
  };
}

export class A2AClient {
  private readonly poolConfig?: ConnectionPoolConfig;
  private readonly requestTimeoutMs: number;
  private readonly agentCardCacheTtlMs: number;
  private readonly agentCardCache = new Map<string, CachedAgentCard>();
  private readonly agentCardInflight = new Map<string, Promise<AgentCard>>();
  private connectionPool: ConnectionPool | null = null;
  private destroyed = false;

  /** Per-peer transport performance stats for adaptive ordering. */
  private readonly peerTransportStats = new Map<string, TransportStats>();

  constructor(config?: A2AClientConfig) {
    this.poolConfig = config?.poolConfig;
    this.requestTimeoutMs = Math.max(1, config?.requestTimeoutMs ?? 30_000);
    this.agentCardCacheTtlMs = Math.max(0, config?.agentCardCacheTtlMs ?? 60_000);
  }

  private getOrCreateStats(peerName: string): TransportStats {
    let stats = this.peerTransportStats.get(peerName);
    if (!stats) {
      stats = new TransportStats();
      this.peerTransportStats.set(peerName, stats);
    }
    return stats;
  }

  private getOrCreatePool(): ConnectionPool {
    if (this.destroyed) throw new Error("A2AClient has been destroyed");
    if (!this.connectionPool) this.connectionPool = new ConnectionPool(this.poolConfig);
    return this.connectionPool;
  }

  private createBaseFetch(): typeof fetch {
    // Preserve testability and embedding runtimes that replace global fetch.
    if (globalThis.fetch !== nativeFetch) {
      return globalThis.fetch.bind(globalThis) as typeof fetch;
    }
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      this.getOrCreatePool().fetch(input, init)) as typeof fetch;
  }

  private createTimedFetch(timeoutMs = this.requestTimeoutMs): typeof fetch {
    const baseFetch = this.createBaseFetch();
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal
        ? AbortSignal.any([init.signal, deadline])
        : deadline;
      return baseFetch(input, { ...init, signal });
    }) as typeof fetch;
  }

  private createFetch(peer: PeerConfig, timeoutMs = this.requestTimeoutMs): typeof fetch {
    const timedFetch = this.createTimedFetch(timeoutMs);
    const authHandler = createAuthHandler(peer);
    return authHandler
      ? createAuthenticatingFetchWithRetry(timedFetch, authHandler)
      : timedFetch;
  }

  private createCardFetch(peer: PeerConfig, timeoutMs = this.requestTimeoutMs): typeof fetch {
    const authenticatedFetch = this.createFetch(peer, timeoutMs);
    return (async (input: RequestInfo | URL, init?: RequestInit) =>
      normalizeAgentCardResponse(await authenticatedFetch(input, init))) as typeof fetch;
  }

  private createTransportFetch(peer: PeerConfig): typeof fetch {
    const authenticatedFetch = this.createFetch(peer);
    return (async (input: RequestInfo | URL, init?: RequestInit) =>
      normalizeOutboundJsonRpcResponse(await authenticatedFetch(input, init), init)) as typeof fetch;
  }

  private buildFactory(peer: PeerConfig): ClientFactory {
    const authFetch = this.createTransportFetch(peer);
    const cardFetch = this.createCardFetch(peer);
    const legacyCompat = { enabled: true } as const;
    const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({
        fetchImpl: cardFetch,
        legacyCompat,
      }),
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: authFetch, legacyCompat }),
        new RestTransportFactory({ fetchImpl: authFetch, legacyCompat }),
        new GrpcTransportFactory({ legacyCompat }),
      ],
    });
    return new ClientFactory(options);
  }

  private cardCacheKey(peer: PeerConfig): string {
    return `${peer.name}\u0000${peer.agentCardUrl}`;
  }

  private invalidateAgentCard(peer: PeerConfig): void {
    this.agentCardCache.delete(this.cardCacheKey(peer));
  }

  private async resolveAgentCard(
    peer: PeerConfig,
    options?: { forceRefresh?: boolean; timeoutMs?: number },
  ): Promise<AgentCard> {
    const key = this.cardCacheKey(peer);
    if (options?.forceRefresh) this.agentCardCache.delete(key);

    const cached = this.agentCardCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.card;
    if (cached) this.agentCardCache.delete(key);

    const pending = this.agentCardInflight.get(key);
    if (pending) return pending;

    const lookup = (async () => {
      const { baseUrl, path } = parseAgentCardUrl(peer.agentCardUrl);
      const resolver = new DefaultAgentCardResolver({
        fetchImpl: this.createCardFetch(peer, options?.timeoutMs ?? this.requestTimeoutMs),
        legacyCompat: { enabled: true },
      });
      const card = await resolver.resolve(baseUrl, path);
      this.agentCardCache.set(key, {
        card,
        expiresAt: Date.now() + this.agentCardCacheTtlMs,
      });
      return card;
    })();

    this.agentCardInflight.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (this.agentCardInflight.get(key) === lookup) {
        this.agentCardInflight.delete(key);
      }
    }
  }

  /** Discover a peer Agent Card. Health probes deliberately bypass the success cache. */
  async discoverAgentCard(peer: PeerConfig, timeoutMs = this.requestTimeoutMs): Promise<Record<string, unknown>> {
    const card = await this.resolveAgentCard(peer, { forceRefresh: true, timeoutMs });
    return card as unknown as Record<string, unknown>;
  }

  /** Send a message with circuit breaking, idempotent retries and transport fallback. */
  async sendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
    options?: {
      healthManager?: PeerHealthManager;
      retryConfig?: RetryConfig;
      log?: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void;
    },
  ): Promise<OutboundSendResult> {
    const healthManager = options?.healthManager;
    const retryConfig = options?.retryConfig;

    if (healthManager && !healthManager.isAvailable(peer.name)) {
      return {
        ok: false,
        statusCode: 503,
        response: { error: `Circuit open: peer "${peer.name}" is unavailable` },
        retryable: false,
      };
    }

    // Generate exactly once. If a response is lost after the remote accepted the
    // request, every retry carries the same A2A idempotency key.
    const suppliedMessageId = asString(message.messageId).trim();
    const stableMessage = {
      ...message,
      messageId: suppliedMessageId || uuidv4(),
    };
    let attempt = 0;
    const doSend = () => {
      if (attempt > 0) this.invalidateAgentCard(peer);
      attempt += 1;
      return this.doSendMessage(peer, stableMessage, options?.log);
    };

    const result = retryConfig && retryConfig.maxRetries > 0
      ? await withRetry(doSend, retryConfig, options?.log, peer.name)
      : await doSend();

    if (healthManager) {
      if (result.ok) healthManager.recordSuccess(peer.name);
      else healthManager.recordFailure(peer.name);
    }
    return result;
  }

  private requestOptions(serviceParameters: Record<string, string>): RequestOptions {
    return {
      serviceParameters: Object.keys(serviceParameters).length ? serviceParameters : undefined,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    };
  }

  /** Resolve once, then try advertised transports in learned priority order. */
  private async doSendMessage(
    peer: PeerConfig,
    message: Record<string, unknown>,
    log?: (level: "info" | "warn", msg: string, details?: Record<string, unknown>) => void,
  ): Promise<OutboundSendResult> {
    const targetAgentName = typeof message.agentName === "string"
      ? message.agentName
      : typeof message.agentId === "string"
        ? message.agentId
        : "";

    const outboundMessage: Message = {
      messageId: asString(message.messageId),
      role: normalizeOutboundRole(message.role) ?? Role.ROLE_USER,
      contextId: asString(message.contextId),
      taskId: asString(message.taskId),
      parts: normalizeOutboundParts(message),
      metadata: targetAgentName ? { agentName: targetAgentName } : undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    const sendParams: SendMessageRequest = {
      tenant: "",
      message: outboundMessage,
      configuration: {
        acceptedOutputModes: ["text"],
        returnImmediately: false,
        taskPushNotificationConfig: undefined,
      },
      metadata: undefined,
    };
    const serviceParameters: Record<string, string> = {};
    if (peer.auth?.token) {
      if (peer.auth.type === "bearer") {
        serviceParameters.authorization = `Bearer ${peer.auth.token}`;
      } else {
        serviceParameters["x-api-key"] = peer.auth.token;
      }
    }

    let agentCard: AgentCard;
    try {
      agentCard = await this.resolveAgentCard(peer);
    } catch (error: unknown) {
      return failureFromError(error);
    }

    const allInterfaces: TransportEndpoint[] = (agentCard.supportedInterfaces ?? []).map(
      (iface) => ({ url: iface.url, transport: iface.protocolBinding }),
    );
    const stats = this.getOrCreateStats(peer.name);
    const transports = allInterfaces.some((endpoint) => stats.count(endpoint.transport) > 0)
      ? adaptiveOrderTransports(allInterfaces, stats)
      : orderTransports(allInterfaces);

    if (transports.length <= 1) {
      return this.doSendViaFactory(
        this.buildFactory(peer),
        agentCard,
        sendParams,
        serviceParameters,
      );
    }

    let lastFailure: OutboundSendResult | undefined;
    for (let index = 0; index < transports.length; index += 1) {
      const endpoint = transports[index];
      log?.("info", "transport.try", {
        peer: peer.name,
        transport: endpoint.transport,
        url: endpoint.url,
        attempt: index + 1,
        total: transports.length,
      });

      const startedAt = Date.now();
      const result = await this.doSendViaTransport(
        peer,
        endpoint,
        agentCard,
        sendParams,
        serviceParameters,
      );
      stats.record(endpoint.transport, result.ok, Date.now() - startedAt);

      if (result.ok || !isRetryableTransportError(result)) {
        if (result.ok && index > 0) {
          log?.("info", "transport.fallback.success", {
            peer: peer.name,
            transport: endpoint.transport,
            url: endpoint.url,
            attemptIndex: index,
          });
        }
        return result;
      }

      lastFailure = result;
      log?.("warn", "transport.fallback", {
        peer: peer.name,
        failedTransport: endpoint.transport,
        statusCode: result.statusCode,
        error: (result.response as { error?: unknown } | null)?.error,
      });
    }

    if (!lastFailure) {
      return {
        ok: false,
        statusCode: 500,
        response: { error: `Peer "${peer.name}" advertises no supported transport` },
        retryable: false,
      };
    }
    return {
      ...lastFailure,
      response: {
        error: `All transports failed for peer "${peer.name}"`,
        cause: lastFailure.response,
      },
    };
  }

  private async doSendViaFactory(
    factory: ClientFactory,
    agentCard: AgentCard,
    sendParams: SendMessageRequest,
    serviceParameters: Record<string, string>,
  ): Promise<OutboundSendResult> {
    try {
      // The card was already resolved above; do not download it again here.
      const client = await factory.createFromAgentCard(agentCard);
      const result = await client.sendMessage(sendParams, this.requestOptions(serviceParameters));
      return { ok: true, statusCode: 200, response: result as unknown as Record<string, unknown> };
    } catch (error: unknown) {
      return failureFromError(error);
    }
  }

  private async doSendViaTransport(
    peer: PeerConfig,
    endpoint: TransportEndpoint,
    agentCard: AgentCard,
    sendParams: SendMessageRequest,
    serviceParameters: Record<string, string>,
  ): Promise<OutboundSendResult> {
    const authFetch = this.createTransportFetch(peer);
    const legacyCompat = { enabled: true } as const;

    try {
      let transport;
      switch (endpoint.transport) {
        case "JSONRPC":
          transport = await new JsonRpcTransportFactory({ fetchImpl: authFetch, legacyCompat })
            .create(endpoint.url, agentCard);
          break;
        case "HTTP+JSON":
          transport = await new RestTransportFactory({ fetchImpl: authFetch, legacyCompat })
            .create(endpoint.url, agentCard);
          break;
        case "GRPC":
          transport = await new GrpcTransportFactory({ legacyCompat })
            .create(endpoint.url, agentCard);
          break;
        default:
          return {
            ok: false,
            statusCode: 400,
            response: { error: `Unsupported transport: ${endpoint.transport}` },
            retryable: false,
          };
      }

      const result = await transport.sendMessage(
        sendParams,
        this.requestOptions(serviceParameters),
      );
      return { ok: true, statusCode: 200, response: result as unknown as Record<string, unknown> };
    } catch (error: unknown) {
      return failureFromError(error);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.connectionPool?.destroy();
    this.connectionPool = null;
    this.agentCardCache.clear();
    this.agentCardInflight.clear();
    this.peerTransportStats.clear();
  }
}
