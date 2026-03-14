/**
 * A2A Gateway — Peer Health Tracking & Circuit Breaker
 *
 * Provides:
 * - Periodic health checks via agent card URL probing
 * - Per-peer circuit breaker (closed/open/half-open)
 * - Retry wrapper with exponential backoff
 */

import type { PeerConfig, PeerResilienceConfig } from "./types.js";

type CircuitState = "closed" | "open" | "half-open";

interface PeerHealth {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  lastCheckedAt?: number;
  totalFailures: number;
  totalSuccesses: number;
}

export interface PeerHealthSnapshot {
  name: string;
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt?: string;
  lastSuccessAt?: string;
  lastCheckedAt?: string;
  totalFailures: number;
  totalSuccesses: number;
}

type LoggerLike = {
  info(msg: string): void;
  warn(msg: string): void;
};

export class PeerHealthTracker {
  private readonly peers: Map<string, PeerHealth> = new Map();
  private readonly config: PeerResilienceConfig;
  private readonly peerConfigs: PeerConfig[];
  private readonly logger: LoggerLike;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(peerConfigs: PeerConfig[], config: PeerResilienceConfig, logger: LoggerLike) {
    this.peerConfigs = peerConfigs;
    this.config = config;
    this.logger = logger;

    for (const peer of peerConfigs) {
      this.peers.set(peer.name, {
        name: peer.name,
        state: "closed",
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
      });
    }
  }

  /** Start periodic health checks. */
  start(): void {
    if (this.healthCheckTimer) return;
    const intervalMs = this.config.healthCheckIntervalSeconds * 1000;
    this.healthCheckTimer = setInterval(() => {
      void this.checkAll();
    }, intervalMs);

    // Initial check
    void this.checkAll();
  }

  /** Stop periodic health checks. */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Check if a peer is available (circuit not open). */
  isAvailable(peerName: string): boolean {
    const health = this.peers.get(peerName);
    if (!health) return true; // Unknown peer — allow

    if (health.state === "closed") return true;

    if (health.state === "half-open") return true; // Allow probe attempt

    // Open: check if cooldown has elapsed → transition to half-open
    const cooldownMs = this.config.circuitBreakerCooldownSeconds * 1000;
    if (health.lastFailureAt && Date.now() - health.lastFailureAt >= cooldownMs) {
      health.state = "half-open";
      return true;
    }

    return false;
  }

  /** Record a successful interaction with a peer. */
  recordSuccess(peerName: string): void {
    const health = this.peers.get(peerName);
    if (!health) return;

    health.consecutiveFailures = 0;
    health.lastSuccessAt = Date.now();
    health.totalSuccesses += 1;

    if (health.state !== "closed") {
      this.logger.info(`a2a-gateway: peer "${peerName}" circuit closed (recovered)`);
      health.state = "closed";
    }
  }

  /** Record a failed interaction with a peer. */
  recordFailure(peerName: string): void {
    const health = this.peers.get(peerName);
    if (!health) return;

    health.consecutiveFailures += 1;
    health.lastFailureAt = Date.now();
    health.totalFailures += 1;

    if (health.state === "half-open") {
      // Half-open probe failed → back to open
      health.state = "open";
      this.logger.warn(`a2a-gateway: peer "${peerName}" circuit re-opened after failed probe`);
    } else if (
      health.state === "closed" &&
      health.consecutiveFailures >= this.config.circuitBreakerThreshold
    ) {
      health.state = "open";
      this.logger.warn(
        `a2a-gateway: peer "${peerName}" circuit opened after ${health.consecutiveFailures} consecutive failures`,
      );
    }
  }

  /** Get snapshot of all peer health states. */
  snapshot(): PeerHealthSnapshot[] {
    const results: PeerHealthSnapshot[] = [];
    for (const health of this.peers.values()) {
      results.push({
        name: health.name,
        state: health.state,
        consecutiveFailures: health.consecutiveFailures,
        lastFailureAt: health.lastFailureAt ? new Date(health.lastFailureAt).toISOString() : undefined,
        lastSuccessAt: health.lastSuccessAt ? new Date(health.lastSuccessAt).toISOString() : undefined,
        lastCheckedAt: health.lastCheckedAt ? new Date(health.lastCheckedAt).toISOString() : undefined,
        totalFailures: health.totalFailures,
        totalSuccesses: health.totalSuccesses,
      });
    }
    return results;
  }

  /** Probe all peers by fetching their agent card URL. */
  private async checkAll(): Promise<void> {
    for (const peerConfig of this.peerConfigs) {
      const health = this.peers.get(peerConfig.name);
      if (!health) continue;

      try {
        const headers: Record<string, string> = {};
        if (peerConfig.auth?.token) {
          if (peerConfig.auth.type === "bearer") {
            headers.authorization = `Bearer ${peerConfig.auth.token}`;
          } else {
            headers["x-api-key"] = peerConfig.auth.token;
          }
        }

        const response = await fetch(peerConfig.agentCardUrl, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(10_000),
        });

        health.lastCheckedAt = Date.now();

        if (response.ok) {
          this.recordSuccess(peerConfig.name);
        } else {
          this.recordFailure(peerConfig.name);
        }
      } catch {
        health.lastCheckedAt = Date.now();
        this.recordFailure(peerConfig.name);
      }
    }
  }
}

/**
 * Retry a function with exponential backoff.
 * Returns the first successful result, or throws the last error.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), 30_000);
        const jitter = Math.random() * baseDelayMs;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
      }
    }
  }
  throw lastError;
}
