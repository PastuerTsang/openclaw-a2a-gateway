/**
 * A2A Gateway — Delegation Manager (Phase 2 Claw-to-Claw)
 *
 * Thin orchestration layer over the existing A2A client:
 * - Policy check (peer + taskType)
 * - Circuit breaker check
 * - Send message via client.sendMessage()
 * - Poll remote task via client.getTask()
 * - Return structured DelegationResult
 */

import { v4 as uuidv4 } from "uuid";

import type { A2AClient } from "./client.js";
import type { AuditLogger } from "./audit.js";
import type { PeerHealthTracker } from "./peer-health.js";
import type {
  DelegationConfig,
  DelegationPolicyRule,
  DelegationResult,
  DelegationTaskType,
  PeerConfig,
} from "./types.js";

type LoggerLike = {
  info(msg: string): void;
  warn(msg: string): void;
};

export interface DelegateOptions {
  peer: string;
  taskType: DelegationTaskType;
  message: string;
  waitForResult?: boolean;
  timeoutMs?: number;
}

export class DelegationManager {
  private readonly config: DelegationConfig;
  private readonly peers: PeerConfig[];
  private readonly client: A2AClient;
  private readonly peerHealth: PeerHealthTracker;
  private readonly audit: AuditLogger;
  private readonly logger: LoggerLike;

  /** Active delegations indexed by delegationId. */
  private readonly active = new Map<string, DelegationResult>();

  /** Track concurrent delegations per peer for maxConcurrent enforcement. */
  private readonly peerConcurrency = new Map<string, number>();

  constructor(
    config: DelegationConfig,
    peers: PeerConfig[],
    client: A2AClient,
    peerHealth: PeerHealthTracker,
    audit: AuditLogger,
    logger: LoggerLike,
  ) {
    this.config = config;
    this.peers = peers;
    this.client = client;
    this.peerHealth = peerHealth;
    this.audit = audit;
    this.logger = logger;
  }

  /**
   * Delegate a task to a peer. Optionally waits for the result.
   */
  async delegate(opts: DelegateOptions): Promise<DelegationResult> {
    const delegationId = uuidv4();
    const startedAt = new Date().toISOString();

    // --- Resolve peer config ---
    const peer = this.peers.find((p) => p.name === opts.peer);
    if (!peer) {
      return this.errorResult(delegationId, opts, startedAt, `Peer not found: "${opts.peer}"`);
    }

    // --- Policy check ---
    const policyError = this.checkPolicy(opts.peer, opts.taskType);
    if (policyError) {
      return this.errorResult(delegationId, opts, startedAt, policyError);
    }

    // --- Circuit breaker check ---
    if (!this.peerHealth.isAvailable(opts.peer)) {
      return this.errorResult(delegationId, opts, startedAt, `Peer "${opts.peer}" is unavailable (circuit breaker open)`);
    }

    // --- Concurrency check ---
    const rule = this.findRule(opts.peer);
    if (rule?.maxConcurrent) {
      const current = this.peerConcurrency.get(opts.peer) || 0;
      if (current >= rule.maxConcurrent) {
        return this.errorResult(delegationId, opts, startedAt, `Peer "${opts.peer}" at max concurrent delegations (${rule.maxConcurrent})`);
      }
    }

    // --- Send message ---
    // Use a fresh contextId to ensure the receiving agent creates an isolated session.
    // Without this, the message may land in an existing conversation context,
    // causing the agent to mix in stale history (the "old session pollution" problem).
    const freshContextId = uuidv4();
    const delegationPrefix = `[Delegated Task | type=${opts.taskType} | id=${delegationId}]\n`;
    const sendResult = await this.client.sendMessage(peer, {
      contextId: freshContextId,
      text: delegationPrefix + opts.message,
      parts: [{ kind: "text", text: delegationPrefix + opts.message }],
    });

    void this.audit.record({
      ts: new Date().toISOString(),
      action: "delegation_send",
      peer: opts.peer,
      detail: `delegationId=${delegationId} taskType=${opts.taskType} waitForResult=${opts.waitForResult ?? true}`,
      ok: sendResult.ok,
    });

    if (!sendResult.ok) {
      this.peerHealth.recordFailure(opts.peer);
      return this.errorResult(delegationId, opts, startedAt, `Send failed: ${JSON.stringify(sendResult.response)}`);
    }

    this.peerHealth.recordSuccess(opts.peer);

    // Extract remote taskId from response
    const response = sendResult.response as Record<string, unknown> | undefined;
    const remoteTaskId = extractTaskId(response);

    const result: DelegationResult = {
      delegationId,
      remoteTaskId: remoteTaskId || "",
      peer: opts.peer,
      taskType: opts.taskType,
      status: "pending",
      startedAt,
    };

    this.active.set(delegationId, result);
    this.incrementConcurrency(opts.peer);

    // --- If not waiting, return immediately ---
    if (opts.waitForResult === false || !remoteTaskId) {
      if (!remoteTaskId) {
        // No task ID means we can't poll; treat as completed with the send response
        result.status = "completed";
        result.result = { text: extractTextFromResponse(response), data: response };
        result.completedAt = new Date().toISOString();
        result.durationMs = Date.now() - new Date(startedAt).getTime();
        this.finalize(delegationId, opts.peer);
      }
      return { ...result };
    }

    // --- Poll for result ---
    const timeoutMs = opts.timeoutMs || this.config.defaultTimeoutMs;
    const pollIntervalMs = this.config.pollIntervalMs;
    const maxAttempts = Math.min(
      this.config.maxPollAttempts,
      Math.ceil(timeoutMs / pollIntervalMs),
    );

    try {
      const finalResult = await this.pollUntilDone(peer, remoteTaskId, result, maxAttempts, pollIntervalMs);
      return finalResult;
    } finally {
      this.finalize(delegationId, opts.peer);
    }
  }

  /**
   * Get the status of a delegation by ID.
   */
  getStatus(delegationId: string): DelegationResult | undefined {
    return this.active.get(delegationId);
  }

  /**
   * List all active (non-terminal) delegations.
   */
  listActive(): DelegationResult[] {
    return Array.from(this.active.values()).filter(
      (d) => d.status === "pending" || d.status === "working",
    );
  }

  /**
   * List all delegations (including completed/failed/timeout).
   */
  listAll(): DelegationResult[] {
    return Array.from(this.active.values());
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private checkPolicy(peerName: string, taskType: DelegationTaskType): string | null {
    const rule = this.findRule(peerName);
    if (!rule) {
      return `Policy: no delegation rule for peer "${peerName}"`;
    }
    if (!rule.allowedTaskTypes.includes(taskType)) {
      return `Policy: task type "${taskType}" not allowed for peer "${peerName}" (allowed: ${rule.allowedTaskTypes.join(", ")})`;
    }
    return null;
  }

  private findRule(peerName: string): DelegationPolicyRule | undefined {
    return this.config.policy.find((r) => r.peer === peerName);
  }

  private async pollUntilDone(
    peer: PeerConfig,
    remoteTaskId: string,
    result: DelegationResult,
    maxAttempts: number,
    pollIntervalMs: number,
  ): Promise<DelegationResult> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollIntervalMs);

      const taskResult = await this.client.getTask(peer, remoteTaskId);
      if (!taskResult.ok || !taskResult.task) {
        // Poll failure is not fatal; keep trying
        this.logger.warn(`a2a-gateway: delegation poll failed for ${remoteTaskId}: ${taskResult.error}`);
        continue;
      }

      const task = taskResult.task;
      const state = extractTaskState(task);

      if (state === "completed") {
        result.status = "completed";
        result.result = extractTaskResult(task);
        result.completedAt = new Date().toISOString();
        result.durationMs = Date.now() - new Date(result.startedAt).getTime();
        void this.audit.record({
          ts: new Date().toISOString(),
          action: "delegation_complete",
          peer: peer.name,
          taskId: remoteTaskId,
          detail: `delegationId=${result.delegationId} durationMs=${result.durationMs}`,
          ok: true,
          durationMs: result.durationMs,
        });
        return { ...result };
      }

      if (state === "failed" || state === "canceled") {
        result.status = "failed";
        result.error = extractTaskError(task) || `Remote task ${state}`;
        result.completedAt = new Date().toISOString();
        result.durationMs = Date.now() - new Date(result.startedAt).getTime();
        void this.audit.record({
          ts: new Date().toISOString(),
          action: "delegation_fail",
          peer: peer.name,
          taskId: remoteTaskId,
          detail: `delegationId=${result.delegationId} error=${result.error}`,
          ok: false,
          durationMs: result.durationMs,
        });
        return { ...result };
      }

      if (state === "working") {
        result.status = "working";
      }
    }

    // Timeout
    result.status = "timeout";
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.now() - new Date(result.startedAt).getTime();
    void this.audit.record({
      ts: new Date().toISOString(),
      action: "delegation_timeout",
      peer: peer.name,
      taskId: remoteTaskId,
      detail: `delegationId=${result.delegationId} durationMs=${result.durationMs}`,
      ok: false,
      durationMs: result.durationMs,
    });
    return { ...result };
  }

  private errorResult(
    delegationId: string,
    opts: DelegateOptions,
    startedAt: string,
    error: string,
  ): DelegationResult {
    return {
      delegationId,
      remoteTaskId: "",
      peer: opts.peer,
      taskType: opts.taskType,
      status: "failed",
      error,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    };
  }

  private incrementConcurrency(peerName: string): void {
    this.peerConcurrency.set(peerName, (this.peerConcurrency.get(peerName) || 0) + 1);
  }

  private decrementConcurrency(peerName: string): void {
    const current = this.peerConcurrency.get(peerName) || 0;
    this.peerConcurrency.set(peerName, Math.max(0, current - 1));
  }

  private finalize(delegationId: string, peerName: string): void {
    this.decrementConcurrency(peerName);
    // Keep in active map for status queries; old entries cleaned up naturally
  }
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

function extractTaskId(response: Record<string, unknown> | undefined): string {
  if (!response) return "";
  // A2A task response: { id: "...", ... } or { result: { id: "..." } }
  if (typeof response.id === "string") return response.id;
  const result = response.result as Record<string, unknown> | undefined;
  if (result && typeof result.id === "string") return result.id;
  // Nested in task wrapper
  const task = (response.task || result?.task) as Record<string, unknown> | undefined;
  if (task && typeof task.id === "string") return task.id;
  return "";
}

function extractTaskState(task: Record<string, unknown>): string {
  // A2A task: { status: { state: "completed" } }
  const status = task.status as Record<string, unknown> | undefined;
  if (status && typeof status.state === "string") return status.state;
  if (typeof task.state === "string") return task.state;
  return "unknown";
}

function extractTaskResult(task: Record<string, unknown>): { text?: string; data?: unknown; artifacts?: unknown[] } {
  const result: { text?: string; data?: unknown; artifacts?: unknown[] } = {};

  // Extract text from task artifacts or history
  const artifacts = task.artifacts as unknown[] | undefined;
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    result.artifacts = artifacts;
    // Try to extract text from first artifact's parts
    const firstArtifact = artifacts[0] as Record<string, unknown> | undefined;
    const parts = firstArtifact?.parts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(parts)) {
      const textParts = parts.filter((p) => p.kind === "text" && typeof p.text === "string");
      if (textParts.length > 0) {
        result.text = textParts.map((p) => p.text).join("\n");
      }
    }
  }

  // Also check history for the last agent message
  const history = task.history as Array<Record<string, unknown>> | undefined;
  if (!result.text && Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === "agent") {
        const parts = msg.parts as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(parts)) {
          const textParts = parts.filter((p) => p.kind === "text" && typeof p.text === "string");
          if (textParts.length > 0) {
            result.text = textParts.map((p) => p.text).join("\n");
            break;
          }
        }
      }
    }
  }

  result.data = task;
  return result;
}

function extractTaskError(task: Record<string, unknown>): string {
  const status = task.status as Record<string, unknown> | undefined;
  if (status) {
    const msg = status.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.text === "string") return msg.text;
    if (typeof status.error === "string") return status.error;
  }
  return "";
}

function extractTextFromResponse(response: Record<string, unknown> | undefined): string {
  if (!response) return "";
  // Try common patterns
  const result = (response.result || response) as Record<string, unknown>;
  const history = result.history as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg.role === "agent") {
        const parts = msg.parts as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(parts)) {
          const textParts = parts.filter((p) => p.kind === "text" && typeof p.text === "string");
          if (textParts.length > 0) return textParts.map((p) => p.text).join("\n");
        }
      }
    }
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
