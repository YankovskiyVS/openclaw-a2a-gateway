import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PeerHealthManager } from "../src/peer-health.js";
import type { PeerConfig, HealthCheckConfig, CircuitBreakerConfig } from "../src/types.js";

const testPeers: PeerConfig[] = [
  { name: "bot-a", agentCardUrl: "http://localhost:18801/.well-known/agent.json" },
  { name: "bot-b", agentCardUrl: "http://localhost:18802/.well-known/agent.json" },
];

const defaultHealthConfig: HealthCheckConfig = {
  enabled: true,
  intervalMs: 60_000, // Long interval so timer doesn't fire in tests
  timeoutMs: 5_000,
};

const defaultCbConfig: CircuitBreakerConfig = {
  failureThreshold: 3,
  resetTimeoutMs: 100, // Short for fast tests
};

const noop = () => {};
const noopLog = noop as any;

function createManager(
  probe: (peer: PeerConfig) => Promise<boolean> = async () => true,
) {
  return new PeerHealthManager(
    testPeers,
    defaultHealthConfig,
    defaultCbConfig,
    probe,
    noopLog,
  );
}

describe("PeerHealthManager", () => {
  it("initializes all peers as unknown/closed", () => {
    const mgr = createManager();
    const state = mgr.getState("bot-a");
    assert.ok(state);
    assert.equal(state.health, "unknown");
    assert.equal(state.circuit, "closed");
    assert.equal(state.consecutiveFailures, 0);
  });

  it("isAvailable returns true for closed circuit", () => {
    const mgr = createManager();
    assert.equal(mgr.isAvailable("bot-a"), true);
  });

  it("isAvailable returns true for unknown peer (fail at send)", () => {
    const mgr = createManager();
    assert.equal(mgr.isAvailable("nonexistent"), true);
  });

  it("recordSuccess resets failures and sets healthy", () => {
    const mgr = createManager();
    mgr.recordFailure("bot-a");
    mgr.recordFailure("bot-a");
    mgr.recordSuccess("bot-a");

    const state = mgr.getState("bot-a")!;
    assert.equal(state.consecutiveFailures, 0);
    assert.equal(state.health, "healthy");
    assert.equal(state.circuit, "closed");
  });

  it("opens circuit after failure threshold", () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    const state = mgr.getState("bot-a")!;
    assert.equal(state.circuit, "open");
    assert.equal(state.health, "unhealthy");
    assert.equal(mgr.isAvailable("bot-a"), false);
  });

  it("transitions from open to half-open after cooldown", async () => {
    const mgr = createManager();
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }
    assert.equal(mgr.isAvailable("bot-a"), false);

    // Wait for resetTimeoutMs (100ms)
    await new Promise((r) => setTimeout(r, 150));

    // Should now transition to half-open
    assert.equal(mgr.isAvailable("bot-a"), true);
    assert.equal(mgr.getState("bot-a")!.circuit, "half-open");
  });

  it("half-open success closes circuit", async () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    await new Promise((r) => setTimeout(r, 150));
    mgr.isAvailable("bot-a"); // triggers half-open

    mgr.recordSuccess("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "closed");
  });

  it("half-open failure re-opens circuit", async () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    await new Promise((r) => setTimeout(r, 150));
    mgr.isAvailable("bot-a"); // triggers half-open

    mgr.recordFailure("bot-a");
    assert.equal(mgr.getState("bot-a")!.circuit, "open");
  });

  it("half-open allows only one in-flight request", async () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    await new Promise((r) => setTimeout(r, 150));

    // First call → half-open, allowed
    assert.equal(mgr.isAvailable("bot-a"), true);
    // Second call → still in-flight, blocked
    assert.equal(mgr.isAvailable("bot-a"), false);
  });

  it("different peers have independent states", () => {
    const mgr = createManager();
    for (let i = 0; i < 3; i++) {
      mgr.recordFailure("bot-a");
    }

    assert.equal(mgr.isAvailable("bot-a"), false);
    assert.equal(mgr.isAvailable("bot-b"), true);
  });

  it("getAllStates returns all peer states", () => {
    const mgr = createManager();
    const states = mgr.getAllStates();
    assert.equal(states.size, 2);
    assert.ok(states.has("bot-a"));
    assert.ok(states.has("bot-b"));
  });

  it("stop clears interval timer", () => {
    const mgr = createManager();
    mgr.start();
    mgr.stop();
    // No assertion needed — just verify it doesn't throw
  });
});
