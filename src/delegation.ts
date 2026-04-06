/**
 * A2A Gateway — Delegation Manager (Phase 2 Claw-to-Claw)
 *
 * Orchestration layer over the A2A client:
 * - Policy check (peer + taskType)
 * - Circuit breaker check
 * - Structured task ID generation (a2a-{node}-{ts}-{rand})
 * - Durable outbox via DelegationLedger (SQLite)
 * - ACK / RESULT state separation
 * - Retry with exponential backoff + dead-letter
 * - Recovery after process restart
 */

import { v4 as uuidv4 } from "uuid";

import type { A2AClient } from "./client.js";
import type { AuditLogger } from "./audit.js";
import type { PeerHealthTracker } from "./peer-health.js";
import {
  DelegationLedger,
  generateTaskId,
  computeNextRetryAt,
  MAX_RETRY_ATTEMPTS,
} from "./delegation-ledger.js";
import type {
  DelegationConfig,
  DelegationPolicyRule,
  DelegationResult,
  DelegationTaskType,
  PeerConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public option / result types
// ---------------------------------------------------------------------------

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

// Re-export so callers don't need to import two places
export type { DelegationLedger };

// ---------------------------------------------------------------------------
// DelegationManager
// ---------------------------------------------------------------------------

/**
 * Prefix embedded in every delegated message so the receiver can identify it
 * and extract both the delegation ID and the durable task ID.
 *
 * Format:  [Delegated Task | type=<type> | id=<delegationId> | taskId=<taskId>]
 */
export function buildDelegationPrefix(
  taskType: DelegationTaskType,
  delegationId: string,
  taskId: string,
): string {
  return `[Delegated Task | type=${taskType} | id=${delegationId} | taskId=${taskId}]\n`;
}

/**
 * Parse the delegation header line out of an inbound message.
 * Returns null if no header found.
 */
export function parseDelegationHeader(
  text: string,
): { taskType: string; delegationId: string; taskId: string } | null {
  const m = text.match(
    /\[Delegated Task \| type=([^\s|]+) \| id=([^\s|]+) \| taskId=([^\s|\]]+)\]/,
  );
  if (!m) return null;
  return { taskType: m[1], delegationId: m[2], taskId: m[3] };
}

export class DelegationManager {
  private readonly config: DelegationConfig;
  private readonly peers: PeerConfig[];
  private readonly client: A2AClient;
  private readonly peerHealth: PeerHealthTracker;
  private readonly audit: AuditLogger;
  private readonly logger: LoggerLike;
  private readonly ledger: DelegationLedger | null;
  private readonly instanceName: string;

  /** In-memory mirror of active delegations (fast status queries). */
  private readonly active = new Map<string, DelegationResult>();

  /** Track concurrent delegations per peer for maxConcurrent enforcement. */
  private readonly peerConcurrency = new Map<string, number>();

  /** Timer for periodic retry of dead_lettered / retry_scheduled tasks. */
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: DelegationConfig,
    peers: PeerConfig[],
    client: A2AClient,
    peerHealth: PeerHealthTracker,
    audit: AuditLogger,
    logger: LoggerLike,
    ledger: DelegationLedger | null = null,
    instanceName = "vm",
  ) {
    this.config = config;
    this.peers = peers;
    this.client = client;
    this.peerHealth = peerHealth;
    this.audit = audit;
    this.logger = logger;
    this.ledger = ledger;
    this.instanceName = instanceName;
  }

  /**
   * Start the retry poll loop. Called once after construction.
   * Recovers in-flight tasks from the ledger (if available).
   */
  start(): void {
    if (this.ledger) {
      void this.recoverPendingTasks();
      // Check for due retries every 15 seconds
      this.retryTimer = setInterval(() => void this.processRetries(), 15_000);
    }
  }

  /** Stop the retry loop (called on plugin shutdown). */
  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Main delegation entry point
  // ---------------------------------------------------------------------------

  async delegate(opts: DelegateOptions): Promise<DelegationResult> {
    const delegationId = uuidv4();
    const startedAt = new Date().toISOString();

    // Generate durable task ID
    const taskId = generateTaskId(this.instanceName);

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
      const errMsg = `Peer "${opts.peer}" is unavailable (circuit breaker open)`;

      // Record in ledger as queued → retry_scheduled (circuit open)
      if (this.ledger) {
        this.ledger.createOutbox({
          taskId,
          delegationId,
          senderNode: this.instanceName,
          targetNode: opts.peer,
          taskType: opts.taskType,
          payloadSummary: opts.message.slice(0, 200),
          payloadJson: opts.message,   // Full payload for retry
          deliveryState: "queued",
        });
        // Move to retry_scheduled so it can be retried when circuit closes
        const nextRetryAt = computeNextRetryAt(1);
        this.ledger.updateOutbox(taskId, {
          deliveryState: "retry_scheduled",
          attempts: 1,
          lastAttemptAt: new Date().toISOString(),
          nextRetryAt: nextRetryAt?.toISOString() ?? null,
          errorCode: "CIRCUIT_OPEN",
          errorMessage: errMsg,
        });
      }

      const result = this.errorResult(delegationId, opts, startedAt, errMsg);
      // Return a pending-like result so caller knows it's queued
      result.status = "pending";
      result.error = `Queued for retry: ${errMsg}`;
      return result;
    }

    // --- Concurrency check ---
    const rule = this.findRule(opts.peer);
    if (rule?.maxConcurrent) {
      const current = this.peerConcurrency.get(opts.peer) || 0;
      if (current >= rule.maxConcurrent) {
        return this.errorResult(
          delegationId,
          opts,
          startedAt,
          `Peer "${opts.peer}" at max concurrent delegations (${rule.maxConcurrent})`,
        );
      }
    }

    // --- Record in ledger (queued) with full payload ---
    if (this.ledger) {
      this.ledger.createOutbox({
        taskId,
        delegationId,
        senderNode: this.instanceName,
        targetNode: opts.peer,
        taskType: opts.taskType,
        payloadSummary: opts.message.slice(0, 200),
        payloadJson: opts.message,    // Full payload for retry/recovery
        deliveryState: "queued",
      });
    }

    // --- Attempt send ---
    return this.attemptSend(delegationId, taskId, peer, opts, startedAt, 0);
  }

  // ---------------------------------------------------------------------------
  // Core send + poll
  // ---------------------------------------------------------------------------

  private async attemptSend(
    delegationId: string,
    taskId: string,
    peer: PeerConfig,
    opts: DelegateOptions,
    startedAt: string,
    previousAttempts: number,
  ): Promise<DelegationResult> {
    const attempts = previousAttempts + 1;
    const now = new Date().toISOString();

    // Update outbox: sending
    if (this.ledger) {
      this.ledger.updateOutbox(taskId, {
        deliveryState: "sending",
        attempts,
        lastAttemptAt: now,
      });
    }

    // Use a fresh contextId per delegation to prevent session pollution
    const freshContextId = uuidv4();
    const prefix = buildDelegationPrefix(opts.taskType, delegationId, taskId);
    const sendResult = await this.client.sendMessage(peer, {
      contextId: freshContextId,
      text: prefix + opts.message,
      parts: [{ kind: "text", text: prefix + opts.message }],
    });

    void this.audit.record({
      ts: now,
      action: "delegation_send",
      peer: opts.peer,
      detail: `delegationId=${delegationId} taskId=${taskId} taskType=${opts.taskType} attempt=${attempts}`,
      ok: sendResult.ok,
    });

    if (!sendResult.ok) {
      this.peerHealth.recordFailure(opts.peer);
      return this.handleSendFailure(delegationId, taskId, peer, opts, startedAt, attempts, sendResult);
    }

    this.peerHealth.recordSuccess(opts.peer);

    // Extract remote task ID from response
    const response = sendResult.response as Record<string, unknown> | undefined;
    const remoteTaskId = extractTaskId(response);

    // --- ACK: send succeeded, remote accepted task ---
    const ackedAt = new Date().toISOString();
    if (this.ledger) {
      this.ledger.updateOutbox(taskId, {
        deliveryState: remoteTaskId ? "acked" : "awaiting_result",
        ackedAt,
        remoteTaskId: remoteTaskId || null,
      });
    }

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

    // --- If not waiting or no remote task ID, return immediately ---
    if (opts.waitForResult === false || !remoteTaskId) {
      if (!remoteTaskId) {
        // No task ID → treat as completed with send response
        result.status = "completed";
        result.result = { text: extractTextFromResponse(response), data: response };
        result.completedAt = new Date().toISOString();
        result.durationMs = Date.now() - new Date(startedAt).getTime();

        if (this.ledger) {
          this.ledger.updateOutbox(taskId, {
            deliveryState: "done",
            resultAt: result.completedAt,
            finalState: "done",
          });
        }
      } else {
        // waitForResult=false: caller will poll later
        if (this.ledger) {
          this.ledger.updateOutbox(taskId, { deliveryState: "awaiting_result" });
        }
      }
      this.finalize(delegationId, opts.peer);
      return { ...result };
    }

    // --- Poll for RESULT ---
    if (this.ledger) {
      this.ledger.updateOutbox(taskId, { deliveryState: "awaiting_result" });
    }

    const timeoutMs = opts.timeoutMs || this.config.defaultTimeoutMs;
    const maxAttempts = Math.min(
      this.config.maxPollAttempts,
      Math.ceil(timeoutMs / this.config.pollIntervalMs),
    );

    try {
      return await this.pollUntilDone(peer, remoteTaskId, taskId, result, maxAttempts, this.config.pollIntervalMs);
    } finally {
      this.finalize(delegationId, opts.peer);
    }
  }

  private handleSendFailure(
    delegationId: string,
    taskId: string,
    _peer: PeerConfig,
    opts: DelegateOptions,
    startedAt: string,
    attempts: number,
    sendResult: { ok: boolean; statusCode: number; response: unknown },
  ): DelegationResult {
    const errMsg = `Send failed (attempt ${attempts}): ${JSON.stringify(sendResult.response)}`;

    if (this.ledger) {
      const nextRetryAt = computeNextRetryAt(attempts);
      if (nextRetryAt && attempts < MAX_RETRY_ATTEMPTS) {
        this.ledger.updateOutbox(taskId, {
          deliveryState: "retry_scheduled",
          nextRetryAt: nextRetryAt.toISOString(),
          errorCode: `HTTP_${sendResult.statusCode}`,
          errorMessage: errMsg,
        });
      } else {
        this.ledger.updateOutbox(taskId, {
          deliveryState: "dead_lettered",
          finalState: "failed",
          errorCode: `HTTP_${sendResult.statusCode}`,
          errorMessage: errMsg,
        });
      }
    }

    return {
      delegationId,
      remoteTaskId: "",
      peer: opts.peer,
      taskType: opts.taskType,
      status: attempts < MAX_RETRY_ATTEMPTS ? "pending" : "failed",
      error: attempts < MAX_RETRY_ATTEMPTS ? `Queued for retry: ${errMsg}` : errMsg,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    };
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  private async pollUntilDone(
    peer: PeerConfig,
    remoteTaskId: string,
    taskId: string,
    result: DelegationResult,
    maxAttempts: number,
    pollIntervalMs: number,
  ): Promise<DelegationResult> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(pollIntervalMs);

      const taskResult = await this.client.getTask(peer, remoteTaskId);
      if (!taskResult.ok || !taskResult.task) {
        this.logger.warn(
          `a2a-gateway: delegation poll failed for ${remoteTaskId}: ${taskResult.error}`,
        );
        continue;
      }

      const task = taskResult.task;
      const state = extractTaskState(task);

      if (state === "completed") {
        const completedAt = new Date().toISOString();
        result.status = "completed";
        result.result = extractTaskResult(task);
        result.completedAt = completedAt;
        result.durationMs = Date.now() - new Date(result.startedAt).getTime();

        if (this.ledger) {
          this.ledger.updateOutbox(taskId, {
            deliveryState: "done",
            resultAt: completedAt,
            finalState: "done",
          });
        }

        void this.audit.record({
          ts: completedAt,
          action: "delegation_complete",
          peer: peer.name,
          taskId: remoteTaskId,
          detail: `delegationId=${result.delegationId} durationMs=${result.durationMs}`,
          ok: true,
          durationMs: result.durationMs,
        });
        return { ...result };
      }

      if (state === "failed" || state === "canceled" || state === "rejected") {
        const completedAt = new Date().toISOString();
        const errMsg = extractTaskError(task) || `Remote task ${state}`;
        result.status = "failed";
        result.error = errMsg;
        result.completedAt = completedAt;
        result.durationMs = Date.now() - new Date(result.startedAt).getTime();

        if (this.ledger) {
          this.ledger.updateOutbox(taskId, {
            deliveryState: "failed",
            resultAt: completedAt,
            finalState: "failed",
            errorCode: `REMOTE_${state.toUpperCase()}`,
            errorMessage: errMsg,
          });
        }

        void this.audit.record({
          ts: completedAt,
          action: "delegation_fail",
          peer: peer.name,
          taskId: remoteTaskId,
          detail: `delegationId=${result.delegationId} error=${errMsg}`,
          ok: false,
          durationMs: result.durationMs,
        });
        return { ...result };
      }

      if (state === "working") {
        result.status = "working";
      }
    }

    // --- Timeout ---
    const completedAt = new Date().toISOString();
    result.status = "timeout";
    result.completedAt = completedAt;
    result.durationMs = Date.now() - new Date(result.startedAt).getTime();

    if (this.ledger) {
      // Schedule retry so recovery can re-poll
      const nextRetryAt = computeNextRetryAt(1);
      this.ledger.updateOutbox(taskId, {
        deliveryState: "retry_scheduled",
        nextRetryAt: nextRetryAt?.toISOString() ?? null,
        errorCode: "POLL_TIMEOUT",
        errorMessage: "Polling timed out waiting for RESULT",
      });
    }

    void this.audit.record({
      ts: completedAt,
      action: "delegation_timeout",
      peer: peer.name,
      taskId: remoteTaskId,
      detail: `delegationId=${result.delegationId} durationMs=${result.durationMs}`,
      ok: false,
      durationMs: result.durationMs,
    });
    return { ...result };
  }

  // ---------------------------------------------------------------------------
  // Recovery
  // ---------------------------------------------------------------------------

  /**
   * On startup: re-queue or re-resume tasks that were in-flight when the
   * process last shut down.
   */
  private async recoverPendingTasks(): Promise<void> {
    if (!this.ledger) return;

    const pending = this.ledger.listPendingRecovery();
    if (pending.length === 0) return;

    this.logger.info(
      `a2a-gateway: delegation recovery: found ${pending.length} pending task(s)`,
    );

    for (const entry of pending) {
      try {
        if (entry.deliveryState === "awaiting_result" && entry.remoteTaskId) {
          // Already ACK'd — resume polling in background
          this.resumePolling(entry).catch((err) => {
            this.logger.warn(
              `a2a-gateway: recovery poll failed for ${entry.taskId}: ${String(err)}`,
            );
          });
        } else if (
          entry.deliveryState === "sending" ||
          entry.deliveryState === "awaiting_ack"
        ) {
          // Was sending when we crashed — move to retry_scheduled (receiver may or may not have got it)
          const nextRetryAt = computeNextRetryAt(entry.attempts + 1);
          if (nextRetryAt) {
            this.ledger.updateOutbox(entry.taskId, {
              deliveryState: "retry_scheduled",
              nextRetryAt: nextRetryAt.toISOString(),
              errorCode: "RESTART_RECOVERY",
              errorMessage: "Process restarted during send — scheduled for retry",
            });
          } else {
            this.ledger.updateOutbox(entry.taskId, {
              deliveryState: "dead_lettered",
              finalState: "failed",
              errorCode: "MAX_RETRIES",
              errorMessage: "Max retry attempts reached during restart recovery",
            });
          }
        }
        // retry_scheduled tasks are picked up by processRetries()
      } catch (err) {
        this.logger.warn(
          `a2a-gateway: recovery error for ${entry.taskId}: ${String(err)}`,
        );
      }
    }
  }

  /**
   * Re-attach polling for an acked task whose RESULT was not received
   * before the last restart.
   */
  private async resumePolling(entry: import("./delegation-ledger.js").OutboxEntry): Promise<void> {
    if (!entry || !entry.remoteTaskId) return;
    const peer = this.peers.find((p) => p.name === entry.targetNode);
    if (!peer) return;

    this.logger.info(
      `a2a-gateway: recovery: resuming poll for delegation ${entry.delegationId} (remoteTask=${entry.remoteTaskId})`,
    );

    const result: DelegationResult = {
      delegationId: entry.delegationId,
      remoteTaskId: entry.remoteTaskId,
      peer: entry.targetNode,
      taskType: entry.taskType as DelegationTaskType,
      status: "working",
      startedAt: entry.createdAt,
    };
    this.active.set(entry.delegationId, result);

    const maxAttempts = this.config.maxPollAttempts;
    await this.pollUntilDone(
      peer,
      entry.remoteTaskId,
      entry.taskId,
      result,
      maxAttempts,
      this.config.pollIntervalMs,
    );
    this.finalize(entry.delegationId, peer.name);
  }

  /**
   * Periodic check: pick up retry_scheduled tasks that are now due.
   */
  private async processRetries(): Promise<void> {
    if (!this.ledger) return;
    const due = this.ledger.listDueRetries();
    for (const entry of due) {
      try {
        const peer = this.peers.find((p) => p.name === entry.targetNode);
        if (!peer) continue;
        if (!this.peerHealth.isAvailable(peer.name)) continue;

        this.logger.info(
          `a2a-gateway: retrying delegation ${entry.delegationId} (attempt ${entry.attempts + 1})`,
        );

        // Use full payload_json for retry — falls back to summary only if null
        const message = entry.payloadJson ?? entry.payloadSummary;
        const opts: DelegateOptions = {
          peer: peer.name,
          taskType: entry.taskType as DelegationTaskType,
          message,
          waitForResult: true,
        };

        await this.attemptSend(
          entry.delegationId,
          entry.taskId,
          peer,
          opts,
          entry.createdAt,
          entry.attempts,
        );
      } catch (err) {
        this.logger.warn(
          `a2a-gateway: retry failed for ${entry.taskId}: ${String(err)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Status queries
  // ---------------------------------------------------------------------------

  getStatus(delegationId: string): DelegationResult | undefined {
    const mem = this.active.get(delegationId);
    if (mem) return mem;

    // Fall back to ledger
    if (this.ledger) {
      const entry = this.ledger.getOutboxByDelegationId(delegationId);
      if (entry) {
        return {
          delegationId: entry.delegationId,
          remoteTaskId: entry.remoteTaskId || "",
          peer: entry.targetNode,
          taskType: entry.taskType as DelegationTaskType,
          status: this.ledgerStateToResultStatus(entry.deliveryState),
          error: entry.errorMessage || undefined,
          startedAt: entry.createdAt,
          completedAt: entry.resultAt || undefined,
        };
      }
    }
    return undefined;
  }

  listActive(): DelegationResult[] {
    return Array.from(this.active.values()).filter(
      (d) => d.status === "pending" || d.status === "working",
    );
  }

  listAll(): DelegationResult[] {
    return Array.from(this.active.values());
  }

  getLedger(): DelegationLedger | null {
    return this.ledger;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private ledgerStateToResultStatus(
    state: string,
  ): DelegationResult["status"] {
    switch (state) {
      case "done":         return "completed";
      case "failed":
      case "dead_lettered": return "failed";
      case "awaiting_result":
      case "acked":        return "working";
      case "retry_scheduled":
      case "sending":
      case "awaiting_ack":
      case "queued":       return "pending";
      default:             return "pending";
    }
  }

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
  }
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

function extractTaskId(response: Record<string, unknown> | undefined): string {
  if (!response) return "";
  if (typeof response.id === "string") return response.id;
  const result = response.result as Record<string, unknown> | undefined;
  if (result && typeof result.id === "string") return result.id;
  const task = (response.task || result?.task) as Record<string, unknown> | undefined;
  if (task && typeof task.id === "string") return task.id;
  return "";
}

function extractTaskState(task: Record<string, unknown>): string {
  const status = task.status as Record<string, unknown> | undefined;
  if (status && typeof status.state === "string") return status.state;
  if (typeof task.state === "string") return task.state;
  return "unknown";
}

function extractTaskResult(
  task: Record<string, unknown>,
): { text?: string; data?: unknown; artifacts?: unknown[] } {
  const result: { text?: string; data?: unknown; artifacts?: unknown[] } = {};

  const artifacts = task.artifacts as unknown[] | undefined;
  if (Array.isArray(artifacts) && artifacts.length > 0) {
    result.artifacts = artifacts;
    const firstArtifact = artifacts[0] as Record<string, unknown> | undefined;
    const parts = firstArtifact?.parts as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(parts)) {
      const textParts = parts.filter((p) => p.kind === "text" && typeof p.text === "string");
      if (textParts.length > 0) {
        result.text = textParts.map((p) => p.text).join("\n");
      }
    }
  }

  const status = task.status as Record<string, unknown> | undefined;
  if (!result.text && status) {
    const statusMsg = status.message as Record<string, unknown> | undefined;
    if (statusMsg) {
      const parts = statusMsg.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        const textParts = parts.filter(
          (p) => (p.kind === "text" || p.type === "text") && typeof p.text === "string",
        );
        if (textParts.length > 0) {
          result.text = textParts.map((p) => p.text).join("\n");
        }
      }
    }
  }

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
  const result = (response.result || response) as Record<string, unknown>;

  const status = result.status as Record<string, unknown> | undefined;
  if (status) {
    const statusMsg = status.message as Record<string, unknown> | undefined;
    if (statusMsg) {
      const parts = statusMsg.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        const textParts = parts.filter(
          (p) => (p.kind === "text" || p.type === "text") && typeof p.text === "string",
        );
        if (textParts.length > 0) return textParts.map((p) => p.text).join("\n");
      }
    }
  }

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
