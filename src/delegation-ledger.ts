/**
 * A2A Delegation Ledger — SQLite-backed persistence for delegation tasks.
 *
 * Provides durable tracking of delegated task lifecycle:
 *   Sender outbox: queued → sending → awaiting_ack → acked → awaiting_result → done/failed/dead_lettered
 *   Receiver inbox: received → accepted → running → done/failed/partial
 *   Event log: immutable append-only timeline of state transitions
 *
 * Uses node:sqlite (Node.js 22+ built-in, experimental).
 * No external dependencies required.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export type SenderState =
  | "queued"
  | "sending"
  | "awaiting_ack"
  | "acked"
  | "awaiting_result"
  | "done"
  | "failed"
  | "retry_scheduled"
  | "dead_lettered"
  | "cancelled";

export type ReceiverState =
  | "received"
  | "deduped"
  | "accepted"
  | "running"
  | "waiting_dependency"
  | "done"
  | "failed"
  | "partial";

// ---------------------------------------------------------------------------
// Execution guard types
// ---------------------------------------------------------------------------

export type ExecutionGuardStatus =
  | "claimed"             // First execution — slot acquired, proceed
  | "duplicate_running"   // Already running or accepted — do not re-execute
  | "duplicate_done"      // Already completed (success)
  | "duplicate_failed"    // Already failed
  | "duplicate_partial";  // Partially completed

export interface ExecutionGuardResult {
  status: ExecutionGuardStatus;
  existingEntry?: InboxEntry;
}

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

export interface OutboxEntry {
  taskId: string;
  delegationId: string;
  senderNode: string;
  targetNode: string;
  taskType: string;
  payloadSummary: string;
  payloadJson: string | null;     // Full message payload for retry/replay
  deliveryState: SenderState;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  ackedAt: string | null;
  resultAt: string | null;
  finalState: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  remoteTaskId: string | null;
}

export interface InboxEntry {
  taskId: string;
  delegationId: string;
  senderNode: string;
  receiverNode: string;
  taskType: string;
  payloadSummary: string;
  payloadJson: string | null;     // Full message payload received
  receiverState: ReceiverState;
  receivedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  resultSummary: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface LedgerEvent {
  id: number;
  taskId: string;
  eventType: string;
  eventPayload: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Task ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a structured delegation task ID.
 * Format: a2a-{node}-{yyyymmddHHmmss}-{rand4}
 * Example: a2a-vm-main-20260406170512-4f8c
 */
export function generateTaskId(senderNode: string): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const ts =
    String(now.getUTCFullYear()) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  const rand = randomBytes(2).toString("hex");
  const node = senderNode.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 20);
  return `a2a-${node}-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Retry backoff schedule
// ---------------------------------------------------------------------------

const RETRY_DELAYS_MS = [
  10_000,    // attempt 1: 10s
  30_000,    // attempt 2: 30s
  90_000,    // attempt 3: 90s
  300_000,   // attempt 4: 5m
  900_000,   // attempt 5: 15m
];

export const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;

/**
 * Compute the next retry time given the number of previous attempts.
 * Returns null when the attempt count exceeds the retry schedule (→ dead_lettered).
 */
export function computeNextRetryAt(attempts: number): Date | null {
  const index = attempts - 1;
  if (index >= RETRY_DELAYS_MS.length) return null;
  const baseDelay = RETRY_DELAYS_MS[index];
  const jitter = baseDelay * 0.1 * (Math.random() * 2 - 1);
  return new Date(Date.now() + baseDelay + jitter);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_BASE = `
  CREATE TABLE IF NOT EXISTS delegated_outbox (
    task_id          TEXT PRIMARY KEY,
    delegation_id    TEXT NOT NULL,
    sender_node      TEXT NOT NULL,
    target_node      TEXT NOT NULL,
    task_type        TEXT NOT NULL,
    payload_summary  TEXT NOT NULL DEFAULT '',
    payload_json     TEXT,
    delivery_state   TEXT NOT NULL DEFAULT 'queued',
    attempts         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    last_attempt_at  TEXT,
    next_retry_at    TEXT,
    acked_at         TEXT,
    result_at        TEXT,
    final_state      TEXT,
    error_code       TEXT,
    error_message    TEXT,
    remote_task_id   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_state      ON delegated_outbox(delivery_state);
  CREATE INDEX IF NOT EXISTS idx_outbox_delegation ON delegated_outbox(delegation_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_retry      ON delegated_outbox(next_retry_at)
    WHERE delivery_state = 'retry_scheduled';

  CREATE TABLE IF NOT EXISTS delegated_inbox (
    task_id          TEXT PRIMARY KEY,
    delegation_id    TEXT NOT NULL,
    sender_node      TEXT NOT NULL,
    receiver_node    TEXT NOT NULL,
    task_type        TEXT NOT NULL,
    payload_summary  TEXT NOT NULL DEFAULT '',
    payload_json     TEXT,
    receiver_state   TEXT NOT NULL DEFAULT 'received',
    received_at      TEXT NOT NULL,
    started_at       TEXT,
    completed_at     TEXT,
    result_summary   TEXT,
    error_code       TEXT,
    error_message    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_delegation ON delegated_inbox(delegation_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_state      ON delegated_inbox(receiver_state);

  CREATE TABLE IF NOT EXISTS delegated_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    event_payload TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_task ON delegated_events(task_id);
`;

// ---------------------------------------------------------------------------
// Row → Entry converters
// ---------------------------------------------------------------------------

function rowToOutbox(row: Record<string, unknown>): OutboxEntry {
  return {
    taskId:        String(row["task_id"] ?? ""),
    delegationId:  String(row["delegation_id"] ?? ""),
    senderNode:    String(row["sender_node"] ?? ""),
    targetNode:    String(row["target_node"] ?? ""),
    taskType:      String(row["task_type"] ?? ""),
    payloadSummary: String(row["payload_summary"] ?? ""),
    payloadJson:   row["payload_json"] != null ? String(row["payload_json"]) : null,
    deliveryState: (row["delivery_state"] as SenderState) ?? "queued",
    attempts:      Number(row["attempts"] ?? 0),
    createdAt:     String(row["created_at"] ?? ""),
    lastAttemptAt: row["last_attempt_at"] != null ? String(row["last_attempt_at"]) : null,
    nextRetryAt:   row["next_retry_at"] != null ? String(row["next_retry_at"]) : null,
    ackedAt:       row["acked_at"] != null ? String(row["acked_at"]) : null,
    resultAt:      row["result_at"] != null ? String(row["result_at"]) : null,
    finalState:    row["final_state"] != null ? String(row["final_state"]) : null,
    errorCode:     row["error_code"] != null ? String(row["error_code"]) : null,
    errorMessage:  row["error_message"] != null ? String(row["error_message"]) : null,
    remoteTaskId:  row["remote_task_id"] != null ? String(row["remote_task_id"]) : null,
  };
}

function rowToInbox(row: Record<string, unknown>): InboxEntry {
  return {
    taskId:        String(row["task_id"] ?? ""),
    delegationId:  String(row["delegation_id"] ?? ""),
    senderNode:    String(row["sender_node"] ?? ""),
    receiverNode:  String(row["receiver_node"] ?? ""),
    taskType:      String(row["task_type"] ?? ""),
    payloadSummary: String(row["payload_summary"] ?? ""),
    payloadJson:   row["payload_json"] != null ? String(row["payload_json"]) : null,
    receiverState: (row["receiver_state"] as ReceiverState) ?? "received",
    receivedAt:    String(row["received_at"] ?? ""),
    startedAt:     row["started_at"] != null ? String(row["started_at"]) : null,
    completedAt:   row["completed_at"] != null ? String(row["completed_at"]) : null,
    resultSummary: row["result_summary"] != null ? String(row["result_summary"]) : null,
    errorCode:     row["error_code"] != null ? String(row["error_code"]) : null,
    errorMessage:  row["error_message"] != null ? String(row["error_message"]) : null,
  };
}

// ---------------------------------------------------------------------------
// DelegationLedger
// ---------------------------------------------------------------------------

export class DelegationLedger {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.db.exec(SCHEMA_BASE);
    this.migrate();
  }

  /**
   * Run schema migrations for existing databases.
   * Adds columns that were added in later versions.
   */
  private migrate(): void {
    // payload_json columns (added in v2)
    for (const table of ["delegated_outbox", "delegated_inbox"]) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN payload_json TEXT`);
      } catch {
        // Column already exists — expected for new databases
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Execution guard — P0 core
  // -------------------------------------------------------------------------

  /**
   * Atomically try to claim execution of an inbound task.
   *
   * Uses BEGIN IMMEDIATE transaction + SELECT-then-INSERT to guarantee
   * that only ONE caller can ever get status='claimed' for a given taskId,
   * even under concurrent requests.
   *
   * Returns:
   *  'claimed'           — Slot acquired. Proceed with execution.
   *  'duplicate_running' — Already accepted/running. Do NOT re-execute.
   *  'duplicate_done'    — Already completed. Return cached result.
   *  'duplicate_failed'  — Already failed. Return error info.
   *  'duplicate_partial' — Already partial. Return partial result.
   */
  tryClaimExecution(params: {
    taskId: string;
    delegationId: string;
    senderNode: string;
    receiverNode: string;
    taskType: string;
    payloadSummary: string;
    payloadJson?: string;
  }): ExecutionGuardResult {
    const now = new Date().toISOString();
    let result: ExecutionGuardResult;

    // BEGIN IMMEDIATE acquires a RESERVED lock, preventing other writers
    // from entering while we check-and-insert.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db
        .prepare("SELECT * FROM delegated_inbox WHERE task_id = ?")
        .get(params.taskId);

      if (!existing) {
        // First time — insert and claim
        this.db.prepare(`
          INSERT INTO delegated_inbox
            (task_id, delegation_id, sender_node, receiver_node, task_type,
             payload_summary, payload_json, receiver_state, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)
        `).run(
          params.taskId,
          params.delegationId,
          params.senderNode,
          params.receiverNode,
          params.taskType,
          params.payloadSummary,
          params.payloadJson ?? null,
          now,
        );

        // Record execution guard acquired event
        this.db.prepare(`
          INSERT INTO delegated_events (task_id, event_type, event_payload, created_at)
          VALUES (?, 'execution_guard_acquired', '{}', ?)
        `).run(params.taskId, now);

        this.db.exec("COMMIT");
        result = { status: "claimed" };
      } else {
        // Duplicate — determine existing state
        const entry = rowToInbox(existing as Record<string, unknown>);
        const state = entry.receiverState;

        // Record the duplicate detection event
        this.db.prepare(`
          INSERT INTO delegated_events (task_id, event_type, event_payload, created_at)
          VALUES (?, 'execution_guard_rejected', ?, ?)
        `).run(
          params.taskId,
          JSON.stringify({ existingState: state, delegationId: params.delegationId }),
          now,
        );

        this.db.exec("COMMIT");

        if (state === "done") {
          result = { status: "duplicate_done", existingEntry: entry };
        } else if (state === "failed") {
          result = { status: "duplicate_failed", existingEntry: entry };
        } else if (state === "partial") {
          result = { status: "duplicate_partial", existingEntry: entry };
        } else {
          // accepted / running / waiting_dependency / received / deduped
          result = { status: "duplicate_running", existingEntry: entry };
        }
      }
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  /**
   * Record a new outbound task. No-ops if task_id already exists (idempotent).
   */
  createOutbox(entry: Pick<OutboxEntry,
    "taskId" | "delegationId" | "senderNode" | "targetNode" | "taskType" | "payloadSummary"
  > & { deliveryState?: SenderState; payloadJson?: string }): void {
    const state = entry.deliveryState ?? "queued";
    this.db.prepare(`
      INSERT OR IGNORE INTO delegated_outbox
        (task_id, delegation_id, sender_node, target_node, task_type,
         payload_summary, payload_json, delivery_state, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      entry.taskId, entry.delegationId, entry.senderNode, entry.targetNode,
      entry.taskType, entry.payloadSummary, entry.payloadJson ?? null, state,
      new Date().toISOString(),
    );
    this.addEvent(entry.taskId, "created", { state });
  }

  updateOutbox(taskId: string, updates: Partial<Omit<OutboxEntry, "taskId" | "delegationId" | "createdAt">>): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.deliveryState  !== undefined) { fields.push("delivery_state = ?");  values.push(updates.deliveryState); }
    if (updates.attempts       !== undefined) { fields.push("attempts = ?");         values.push(updates.attempts); }
    if (updates.lastAttemptAt  !== undefined) { fields.push("last_attempt_at = ?");  values.push(updates.lastAttemptAt); }
    if (updates.nextRetryAt    !== undefined) { fields.push("next_retry_at = ?");    values.push(updates.nextRetryAt); }
    if (updates.ackedAt        !== undefined) { fields.push("acked_at = ?");         values.push(updates.ackedAt); }
    if (updates.resultAt       !== undefined) { fields.push("result_at = ?");        values.push(updates.resultAt); }
    if (updates.finalState     !== undefined) { fields.push("final_state = ?");      values.push(updates.finalState); }
    if (updates.errorCode      !== undefined) { fields.push("error_code = ?");       values.push(updates.errorCode); }
    if (updates.errorMessage   !== undefined) { fields.push("error_message = ?");    values.push(updates.errorMessage); }
    if (updates.remoteTaskId   !== undefined) { fields.push("remote_task_id = ?");   values.push(updates.remoteTaskId); }
    if (updates.senderNode     !== undefined) { fields.push("sender_node = ?");      values.push(updates.senderNode); }
    if (updates.targetNode     !== undefined) { fields.push("target_node = ?");      values.push(updates.targetNode); }
    if (updates.taskType       !== undefined) { fields.push("task_type = ?");        values.push(updates.taskType); }
    if (updates.payloadSummary !== undefined) { fields.push("payload_summary = ?");  values.push(updates.payloadSummary); }
    if (updates.payloadJson    !== undefined) { fields.push("payload_json = ?");     values.push(updates.payloadJson); }

    if (fields.length === 0) return;
    values.push(taskId);
    this.db.prepare(`UPDATE delegated_outbox SET ${fields.join(", ")} WHERE task_id = ?`).run(...values);

    if (updates.deliveryState) {
      this.addEvent(taskId, "state_change", { state: updates.deliveryState });
    }
  }

  getOutbox(taskId: string): OutboxEntry | null {
    const row = this.db.prepare("SELECT * FROM delegated_outbox WHERE task_id = ?").get(taskId);
    return row ? rowToOutbox(row as Record<string, unknown>) : null;
  }

  getOutboxByDelegationId(delegationId: string): OutboxEntry | null {
    const row = this.db.prepare("SELECT * FROM delegated_outbox WHERE delegation_id = ?").get(delegationId);
    return row ? rowToOutbox(row as Record<string, unknown>) : null;
  }

  /** Tasks that need to be re-queued / recovered after a process restart. */
  listPendingRecovery(): OutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM delegated_outbox
      WHERE delivery_state IN ('sending', 'awaiting_ack', 'awaiting_result', 'retry_scheduled')
      ORDER BY created_at ASC
    `).all();
    return (rows as Record<string, unknown>[]).map(rowToOutbox);
  }

  /** Tasks in retry_scheduled state whose next_retry_at is past due. */
  listDueRetries(): OutboxEntry[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM delegated_outbox
      WHERE delivery_state = 'retry_scheduled' AND next_retry_at <= ?
      ORDER BY next_retry_at ASC
    `).all(now);
    return (rows as Record<string, unknown>[]).map(rowToOutbox);
  }

  listAllOutbox(limit = 100): OutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM delegated_outbox ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    return (rows as Record<string, unknown>[]).map(rowToOutbox);
  }

  listDeadLetters(): OutboxEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM delegated_outbox WHERE delivery_state = 'dead_lettered'
      ORDER BY created_at DESC
    `).all();
    return (rows as Record<string, unknown>[]).map(rowToOutbox);
  }

  // -------------------------------------------------------------------------
  // Dead-letter replay (P2)
  // -------------------------------------------------------------------------

  /**
   * Re-queue a dead_lettered task for retry.
   * Creates a new outbox entry with a fresh taskId using the original payload.
   * Marks the original as 'cancelled' with a supersededBy reference.
   *
   * Returns the new taskId, or null if the original task is not dead_lettered.
   */
  replayDeadLetter(originalTaskId: string): { newTaskId: string; originalTaskId: string } | null {
    const original = this.getOutbox(originalTaskId);
    if (!original || original.deliveryState !== "dead_lettered") return null;

    const newTaskId = generateTaskId(original.senderNode);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Create new queued entry with original payload
      this.db.prepare(`
        INSERT INTO delegated_outbox
          (task_id, delegation_id, sender_node, target_node, task_type,
           payload_summary, payload_json, delivery_state, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
      `).run(
        newTaskId,
        original.delegationId + "-replay",
        original.senderNode,
        original.targetNode,
        original.taskType,
        original.payloadSummary,
        original.payloadJson,
        now,
      );

      // Mark original as cancelled (superseded)
      this.db.prepare(`
        UPDATE delegated_outbox
        SET delivery_state = 'cancelled', error_message = ?
        WHERE task_id = ?
      `).run(`Superseded by replay: ${newTaskId}`, originalTaskId);

      // Events
      this.db.prepare(`
        INSERT INTO delegated_events (task_id, event_type, event_payload, created_at)
        VALUES (?, 'dead_letter_replayed', ?, ?)
      `).run(originalTaskId, JSON.stringify({ newTaskId }), now);

      this.db.prepare(`
        INSERT INTO delegated_events (task_id, event_type, event_payload, created_at)
        VALUES (?, 'replayed_from', ?, ?)
      `).run(newTaskId, JSON.stringify({ originalTaskId }), now);

      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    }

    return { newTaskId, originalTaskId };
  }

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /**
   * Record a received inbound delegation task.
   * Returns true if newly created, false if task_id already exists (duplicate → deduped).
   *
   * NOTE: For atomic execution guard, prefer tryClaimExecution() instead.
   * This method does NOT use a transaction — use only for non-critical logging.
   */
  createInboxIfNew(entry: Pick<InboxEntry,
    "taskId" | "delegationId" | "senderNode" | "receiverNode" | "taskType" | "payloadSummary"
  > & { receiverState?: ReceiverState; payloadJson?: string }): boolean {
    const existing = this.db.prepare("SELECT task_id FROM delegated_inbox WHERE task_id = ?").get(entry.taskId);
    if (existing) return false;

    const state = entry.receiverState ?? "received";
    this.db.prepare(`
      INSERT INTO delegated_inbox
        (task_id, delegation_id, sender_node, receiver_node, task_type,
         payload_summary, payload_json, receiver_state, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.taskId, entry.delegationId, entry.senderNode, entry.receiverNode,
      entry.taskType, entry.payloadSummary, entry.payloadJson ?? null, state,
      new Date().toISOString(),
    );
    this.addEvent(entry.taskId, "received", { state });
    return true;
  }

  updateInbox(taskId: string, updates: Partial<Pick<InboxEntry,
    "receiverState" | "startedAt" | "completedAt" | "resultSummary" | "errorCode" | "errorMessage"
  >>): void {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (updates.receiverState  !== undefined) { fields.push("receiver_state = ?");  values.push(updates.receiverState); }
    if (updates.startedAt      !== undefined) { fields.push("started_at = ?");      values.push(updates.startedAt); }
    if (updates.completedAt    !== undefined) { fields.push("completed_at = ?");    values.push(updates.completedAt); }
    if (updates.resultSummary  !== undefined) { fields.push("result_summary = ?");  values.push(updates.resultSummary); }
    if (updates.errorCode      !== undefined) { fields.push("error_code = ?");      values.push(updates.errorCode); }
    if (updates.errorMessage   !== undefined) { fields.push("error_message = ?");   values.push(updates.errorMessage); }

    if (fields.length === 0) return;
    values.push(taskId);
    this.db.prepare(`UPDATE delegated_inbox SET ${fields.join(", ")} WHERE task_id = ?`).run(...values);
    if (updates.receiverState) {
      this.addEvent(taskId, "receiver_state_change", { state: updates.receiverState });
    }
  }

  getInbox(taskId: string): InboxEntry | null {
    const row = this.db.prepare("SELECT * FROM delegated_inbox WHERE task_id = ?").get(taskId);
    return row ? rowToInbox(row as Record<string, unknown>) : null;
  }

  getInboxByDelegationId(delegationId: string): InboxEntry | null {
    const row = this.db.prepare("SELECT * FROM delegated_inbox WHERE delegation_id = ?").get(delegationId);
    return row ? rowToInbox(row as Record<string, unknown>) : null;
  }

  listInbox(limit = 100): InboxEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM delegated_inbox ORDER BY received_at DESC LIMIT ?
    `).all(limit);
    return (rows as Record<string, unknown>[]).map(rowToInbox);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  addEvent(taskId: string, eventType: string, payload: unknown = {}): void {
    this.db.prepare(`
      INSERT INTO delegated_events (task_id, event_type, event_payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(taskId, eventType, JSON.stringify(payload), new Date().toISOString());
  }

  getEvents(taskId: string): LedgerEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM delegated_events WHERE task_id = ? ORDER BY id ASC
    `).all(taskId);
    return (rows as Record<string, unknown>[]).map((row) => ({
      id:           Number(row["id"] ?? 0),
      taskId:       String(row["task_id"] ?? ""),
      eventType:    String(row["event_type"] ?? ""),
      eventPayload: String(row["event_payload"] ?? "{}"),
      createdAt:    String(row["created_at"] ?? ""),
    }));
  }

  // -------------------------------------------------------------------------
  // Summary / Stats (P2: Phone-side visibility)
  // -------------------------------------------------------------------------

  getStats(): Record<string, number> {
    const outboxRows = this.db.prepare(`
      SELECT delivery_state, COUNT(*) as cnt FROM delegated_outbox GROUP BY delivery_state
    `).all() as Array<{ delivery_state: string; cnt: number }>;

    const inboxRows = this.db.prepare(`
      SELECT receiver_state, COUNT(*) as cnt FROM delegated_inbox GROUP BY receiver_state
    `).all() as Array<{ receiver_state: string; cnt: number }>;

    const stats: Record<string, number> = {};
    for (const row of outboxRows) {
      stats[`outbox_${row.delivery_state}`] = row.cnt;
    }
    for (const row of inboxRows) {
      stats[`inbox_${row.receiver_state}`] = row.cnt;
    }
    return stats;
  }

  /**
   * Quick summary for phone-side operator visibility.
   * Answers: "what tasks are stuck and where?"
   */
  getSummary(): {
    pendingCount: number;
    retryCount: number;
    deadLetterCount: number;
    inboxRunningCount: number;
    recentDeadLetters: OutboxEntry[];
    recentPending: OutboxEntry[];
  } {
    const stats = this.getStats();

    const pendingCount =
      (stats["outbox_queued"] ?? 0) +
      (stats["outbox_sending"] ?? 0) +
      (stats["outbox_awaiting_ack"] ?? 0) +
      (stats["outbox_awaiting_result"] ?? 0) +
      (stats["outbox_acked"] ?? 0);

    const retryCount = stats["outbox_retry_scheduled"] ?? 0;
    const deadLetterCount = stats["outbox_dead_lettered"] ?? 0;
    const inboxRunningCount =
      (stats["inbox_accepted"] ?? 0) +
      (stats["inbox_running"] ?? 0) +
      (stats["inbox_waiting_dependency"] ?? 0);

    const recentDeadLetters = this.listDeadLetters().slice(0, 5);
    const recentPending = (this.db.prepare(`
      SELECT * FROM delegated_outbox
      WHERE delivery_state IN ('queued','sending','awaiting_ack','awaiting_result','acked','retry_scheduled')
      ORDER BY created_at DESC LIMIT 10
    `).all() as Record<string, unknown>[]).map(rowToOutbox);

    return {
      pendingCount,
      retryCount,
      deadLetterCount,
      inboxRunningCount,
      recentDeadLetters,
      recentPending,
    };
  }
}
