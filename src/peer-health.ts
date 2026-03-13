import type {
  PeerConfig,
  HealthCheckConfig,
  CircuitBreakerConfig,
  CircuitState,
  HealthStatus,
  PeerState,
} from "./types.js";

type LogFn = (level: "info" | "warn" | "error", msg: string, details?: Record<string, unknown>) => void;
type HealthProbe = (peer: PeerConfig) => Promise<boolean>;

/**
 * Manages per-peer health checks and circuit breaker state.
 *
 * Health checks periodically probe each peer's Agent Card endpoint.
 * The circuit breaker follows the standard three-state pattern:
 *   closed → open → half-open → closed
 */
export class PeerHealthManager {
  private readonly states = new Map<string, PeerState>();
  private readonly peers: PeerConfig[];
  private readonly healthConfig: HealthCheckConfig;
  private readonly cbConfig: CircuitBreakerConfig;
  private readonly probe: HealthProbe;
  private readonly log: LogFn;
  private timer: ReturnType<typeof setInterval> | null = null;
  private halfOpenInFlight = new Set<string>();

  constructor(
    peers: PeerConfig[],
    healthConfig: HealthCheckConfig,
    cbConfig: CircuitBreakerConfig,
    probe: HealthProbe,
    log: LogFn,
  ) {
    this.peers = peers;
    this.healthConfig = healthConfig;
    this.cbConfig = cbConfig;
    this.probe = probe;
    this.log = log;

    // Initialize state for each peer
    for (const peer of peers) {
      this.states.set(peer.name, {
        health: "unknown",
        circuit: "closed",
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastCheckAt: null,
      });
    }
  }

  /** Start periodic health checks. */
  start(): void {
    if (!this.healthConfig.enabled || this.peers.length === 0) return;

    this.log("info", "peer.health.start", {
      peers: this.peers.map((p) => p.name),
      interval_ms: this.healthConfig.intervalMs,
    });

    // Run immediately, then on interval
    this.runHealthChecks();
    this.timer = setInterval(() => this.runHealthChecks(), this.healthConfig.intervalMs);
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Check if a peer is available for requests (circuit is not open). */
  isAvailable(peerName: string): boolean {
    const state = this.states.get(peerName);
    if (!state) return true; // Unknown peer → allow (fail at send)

    if (state.circuit === "closed") return true;

    if (state.circuit === "open") {
      // Check if cooldown has elapsed → transition to half-open
      if (
        state.lastFailureAt &&
        Date.now() - state.lastFailureAt >= this.cbConfig.resetTimeoutMs
      ) {
        state.circuit = "half-open";
        this.halfOpenInFlight.add(peerName); // Only one probe allowed
        this.log("info", "peer.circuit.half-open", { peer: peerName });
        return true;
      }
      return false;
    }

    // half-open: allow one request at a time
    if (this.halfOpenInFlight.has(peerName)) return false;
    this.halfOpenInFlight.add(peerName);
    return true;
  }

  /** Record a successful call to a peer. */
  recordSuccess(peerName: string): void {
    const state = this.states.get(peerName);
    if (!state) return;

    const prevCircuit = state.circuit;
    state.consecutiveFailures = 0;
    state.health = "healthy";
    this.halfOpenInFlight.delete(peerName);

    if (state.circuit !== "closed") {
      state.circuit = "closed";
      this.log("info", "peer.circuit.closed", {
        peer: peerName,
        previous: prevCircuit,
      });
    }
  }

  /** Record a failed call to a peer. May trigger circuit open. */
  recordFailure(peerName: string): void {
    const state = this.states.get(peerName);
    if (!state) return;

    state.consecutiveFailures += 1;
    state.lastFailureAt = Date.now();
    this.halfOpenInFlight.delete(peerName);

    // half-open failure → back to open
    if (state.circuit === "half-open") {
      state.circuit = "open";
      this.log("warn", "peer.circuit.open", {
        peer: peerName,
        reason: "half-open probe failed",
        consecutive_failures: state.consecutiveFailures,
      });
      return;
    }

    // closed: check threshold
    if (
      state.circuit === "closed" &&
      state.consecutiveFailures >= this.cbConfig.failureThreshold
    ) {
      state.circuit = "open";
      state.health = "unhealthy";
      this.log("warn", "peer.circuit.open", {
        peer: peerName,
        reason: "failure threshold reached",
        consecutive_failures: state.consecutiveFailures,
      });
    }
  }

  /** Get state for a single peer. */
  getState(peerName: string): PeerState | undefined {
    return this.states.get(peerName);
  }

  /** Get states for all peers. */
  getAllStates(): Map<string, PeerState> {
    return new Map(this.states);
  }

  /** Run health checks for all peers. */
  private runHealthChecks(): void {
    for (const peer of this.peers) {
      this.checkPeer(peer).catch((err) => {
        this.log("error", "peer.health.check-error", {
          peer: peer.name,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /** Probe a single peer and update its state. */
  private async checkPeer(peer: PeerConfig): Promise<void> {
    const state = this.states.get(peer.name);
    if (!state) return;

    const healthy = await this.probe(peer);
    state.lastCheckAt = Date.now();

    if (healthy) {
      this.recordSuccess(peer.name);
    } else {
      state.health = "unhealthy";
      this.recordFailure(peer.name);
    }
  }
}
