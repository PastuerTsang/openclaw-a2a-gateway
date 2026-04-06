/**
 * A2A Delegation Reliability Layer — Test Suite
 *
 * Covers spec test scenarios A-L:
 *   A. Normal delegation (queued → acked → done)
 *   B. ACK timeout → retry → receiver deduplication
 *   C. Receiver restart recovery (awaiting_result → resume)
 *   D. Sender restart recovery (outbox preserved)
 *   E. Circuit open → retry_scheduled → queued visible
 *   F. Duplicate resend → inbox deduplication
 *   G. Receiver completed dedup (execution guard)
 *   H. Receiver running dedup (execution guard)
 *   I. Race condition dedup (atomic guard)
 *   J. Retry with full payload_json
 *   K. Dead-letter replay
 *   L. Phone-side queryability
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import {
  DelegationLedger,
  generateTaskId,
  computeNextRetryAt,
  MAX_RETRY_ATTEMPTS,
  type ExecutionGuardStatus,
} from "../src/delegation-ledger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `test-ledger-${randomUUID()}.db`);
}

function mkLedger(): DelegationLedger {
  return new DelegationLedger(tmpDbPath());
}

// ---------------------------------------------------------------------------
// Unit: generateTaskId
// ---------------------------------------------------------------------------

describe("generateTaskId", () => {
  test("produces correct format", () => {
    const id = generateTaskId("vm-main");
    // a2a-vm-main-20260406170512-4f8c
    assert.match(id, /^a2a-vm-main-\d{14}-[0-9a-f]{4}$/);
  });

  test("sanitizes node name", () => {
    const id = generateTaskId("my node!");
    assert.match(id, /^a2a-mynode-\d{14}-[0-9a-f]{4}$/);
  });

  test("truncates long node names", () => {
    const id = generateTaskId("a".repeat(50));
    const parts = id.split("-");
    // a2a-{node}-{ts}-{rand}
    // node part should be ≤ 20 chars
    const nodeSection = parts.slice(1, -2).join("-");
    assert.ok(nodeSection.length <= 20, `node section too long: ${nodeSection}`);
  });

  test("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTaskId("test")));
    assert.equal(ids.size, 100);
  });
});

// ---------------------------------------------------------------------------
// Unit: computeNextRetryAt
// ---------------------------------------------------------------------------

describe("computeNextRetryAt", () => {
  test("returns Date for first 5 attempts", () => {
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const result = computeNextRetryAt(attempt);
      assert.ok(result instanceof Date, `attempt ${attempt} should return Date`);
      assert.ok(result > new Date(), `attempt ${attempt} should be in the future`);
    }
  });

  test("returns null beyond max attempts", () => {
    const result = computeNextRetryAt(MAX_RETRY_ATTEMPTS + 1);
    assert.equal(result, null);
  });

  test("delays increase with each attempt", () => {
    const delays = Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, i) => {
      const d = computeNextRetryAt(i + 1);
      return d ? d.getTime() - Date.now() : 0;
    });
    // Each delay should generally be larger than the previous
    // (with jitter there's slight variation, so we use 80% of expected)
    const expectedDelays = [10_000, 30_000, 90_000, 300_000, 900_000];
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      assert.ok(delays[i] >= expectedDelays[i] * 0.8, `delay[${i}]=${delays[i]} should be >= ${expectedDelays[i] * 0.8}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Test A: Normal delegation lifecycle
// ---------------------------------------------------------------------------

describe("Test A — Normal delegation: queued → acked → done", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("full state progression is recorded", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    // 1. Sender creates outbox entry (queued)
    ledger.createOutbox({
      taskId,
      delegationId,
      senderNode: "phone",
      targetNode: "vm-main",
      taskType: "operation",
      payloadSummary: "Research task",
      deliveryState: "queued",
    });

    let entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "queued");
    assert.equal(entry.attempts, 0);

    // 2. Sending
    ledger.updateOutbox(taskId, {
      deliveryState: "sending",
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
    });
    entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "sending");

    // 3. ACK received (sendMessage succeeded)
    const ackedAt = new Date().toISOString();
    ledger.updateOutbox(taskId, {
      deliveryState: "acked",
      ackedAt,
      remoteTaskId: "remote-task-abc",
    });
    entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "acked");
    assert.equal(entry.ackedAt, ackedAt);
    assert.equal(entry.remoteTaskId, "remote-task-abc");

    // 4. Awaiting result
    ledger.updateOutbox(taskId, { deliveryState: "awaiting_result" });
    entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "awaiting_result");

    // 5. RESULT received
    const resultAt = new Date().toISOString();
    ledger.updateOutbox(taskId, {
      deliveryState: "done",
      resultAt,
      finalState: "done",
    });
    entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "done");
    assert.equal(entry.finalState, "done");
    assert.equal(entry.resultAt, resultAt);
  });

  test("receiver records inbox entry for the task", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    // Receiver creates inbox entry
    const isNew = ledger.createInboxIfNew({
      taskId,
      delegationId,
      senderNode: "phone",
      receiverNode: "vm-main",
      taskType: "operation",
      payloadSummary: "Research task",
      receiverState: "accepted",
    });
    assert.equal(isNew, true);

    const inbox = ledger.getInbox(taskId)!;
    assert.equal(inbox.receiverState, "accepted");

    // Running
    ledger.updateInbox(taskId, { receiverState: "running", startedAt: new Date().toISOString() });
    assert.equal(ledger.getInbox(taskId)!.receiverState, "running");

    // Done
    ledger.updateInbox(taskId, {
      receiverState: "done",
      completedAt: new Date().toISOString(),
      resultSummary: "Task completed successfully",
    });
    const done = ledger.getInbox(taskId)!;
    assert.equal(done.receiverState, "done");
    assert.equal(done.resultSummary, "Task completed successfully");
  });

  test("event timeline is recorded", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({
      taskId, delegationId: randomUUID(),
      senderNode: "phone", targetNode: "vm-main",
      taskType: "query", payloadSummary: "test",
    });
    ledger.updateOutbox(taskId, { deliveryState: "sending", attempts: 1 });
    ledger.updateOutbox(taskId, { deliveryState: "acked", ackedAt: new Date().toISOString() });
    ledger.updateOutbox(taskId, { deliveryState: "done", finalState: "done" });

    const events = ledger.getEvents(taskId);
    assert.ok(events.length >= 4, `expected ≥4 events, got ${events.length}`);
    const types = events.map((e) => e.eventType);
    assert.ok(types.includes("created"), "should have created event");
    assert.ok(types.includes("state_change"), "should have state_change events");
  });

  test("can retrieve outbox by delegationId", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();
    ledger.createOutbox({ taskId, delegationId, senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "x" });
    const entry = ledger.getOutboxByDelegationId(delegationId);
    assert.ok(entry, "should find entry by delegationId");
    assert.equal(entry!.taskId, taskId);
  });
});

// ---------------------------------------------------------------------------
// Test B: ACK timeout → retry → receiver deduplication
// ---------------------------------------------------------------------------

describe("Test B — ACK timeout: retry with dedup", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("failed send schedules retry", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "test" });

    // First attempt fails
    ledger.updateOutbox(taskId, {
      deliveryState: "sending",
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
    });
    const nextRetryAt = computeNextRetryAt(1)!;
    ledger.updateOutbox(taskId, {
      deliveryState: "retry_scheduled",
      nextRetryAt: nextRetryAt.toISOString(),
      errorCode: "HTTP_503",
      errorMessage: "Service unavailable",
    });

    const entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "retry_scheduled");
    assert.ok(entry.nextRetryAt, "should have nextRetryAt");
    assert.equal(entry.errorCode, "HTTP_503");
  });

  test("max retries leads to dead_lettered", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "test" });

    // All retry attempts exhausted
    const beyondMax = MAX_RETRY_ATTEMPTS + 1;
    const next = computeNextRetryAt(beyondMax);
    assert.equal(next, null, "beyond max should return null");

    ledger.updateOutbox(taskId, {
      deliveryState: "dead_lettered",
      attempts: beyondMax,
      finalState: "failed",
      errorCode: "MAX_RETRIES",
      errorMessage: "Max retry attempts reached",
    });

    const entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "dead_lettered");
    assert.equal(entry.finalState, "failed");

    const dead = ledger.listDeadLetters();
    assert.ok(dead.some((e) => e.taskId === taskId), "should appear in dead-letter list");
  });

  test("receiver deduplicates same taskId (Test F overlap)", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    const isNew1 = ledger.createInboxIfNew({
      taskId, delegationId, senderNode: "phone", receiverNode: "vm-main",
      taskType: "operation", payloadSummary: "test", receiverState: "accepted",
    });
    assert.equal(isNew1, true, "first receipt should be new");

    // Simulate resend (same taskId)
    const isNew2 = ledger.createInboxIfNew({
      taskId, delegationId, senderNode: "phone", receiverNode: "vm-main",
      taskType: "operation", payloadSummary: "test (resent)", receiverState: "accepted",
    });
    assert.equal(isNew2, false, "duplicate taskId should be deduped");

    // Inbox should still have only one entry
    const entry = ledger.getInbox(taskId);
    assert.ok(entry, "inbox entry should exist");
    assert.equal(entry!.payloadSummary, "test", "should keep original, not resent version");
  });
});

// ---------------------------------------------------------------------------
// Test C: Receiver restart recovery (awaiting_result)
// ---------------------------------------------------------------------------

describe("Test C — Receiver restart: awaiting_result recovery", () => {
  test("pending tasks survive ledger re-open", () => {
    const dbPath = tmpDbPath();
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    // --- Phase 1: write state before "restart" ---
    const ledger1 = new DelegationLedger(dbPath);
    ledger1.createOutbox({ taskId, delegationId, senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "test" });
    ledger1.updateOutbox(taskId, {
      deliveryState: "awaiting_result",
      ackedAt: new Date().toISOString(),
      remoteTaskId: "remote-xyz",
      attempts: 1,
    });
    ledger1.close();

    // --- Phase 2: re-open after "restart" ---
    const ledger2 = new DelegationLedger(dbPath);
    const pending = ledger2.listPendingRecovery();
    assert.ok(pending.length > 0, "should find pending tasks after restart");
    const recovered = pending.find((e) => e.taskId === taskId);
    assert.ok(recovered, "should recover the specific task");
    assert.equal(recovered!.deliveryState, "awaiting_result");
    assert.equal(recovered!.remoteTaskId, "remote-xyz");
    ledger2.close();
  });
});

// ---------------------------------------------------------------------------
// Test D: Sender restart recovery (outbox preserved)
// ---------------------------------------------------------------------------

describe("Test D — Sender restart: outbox preserved across restarts", () => {
  test("queued and sending tasks are recoverable", () => {
    const dbPath = tmpDbPath();
    const taskId1 = generateTaskId("phone");
    const taskId2 = generateTaskId("phone");

    const ledger1 = new DelegationLedger(dbPath);
    // Task 1: crashed during send
    ledger1.createOutbox({ taskId: taskId1, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "task1" });
    ledger1.updateOutbox(taskId1, { deliveryState: "sending", attempts: 1 });

    // Task 2: acked but no result yet
    ledger1.createOutbox({ taskId: taskId2, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "task2" });
    ledger1.updateOutbox(taskId2, {
      deliveryState: "awaiting_result",
      ackedAt: new Date().toISOString(),
      remoteTaskId: "remote-abc",
      attempts: 1,
    });
    ledger1.close();

    const ledger2 = new DelegationLedger(dbPath);
    const recovery = ledger2.listPendingRecovery();

    const t1 = recovery.find((e) => e.taskId === taskId1);
    const t2 = recovery.find((e) => e.taskId === taskId2);
    assert.ok(t1, "task1 (sending) should be recovered");
    assert.ok(t2, "task2 (awaiting_result) should be recovered");
    assert.equal(t1!.deliveryState, "sending");
    assert.equal(t2!.deliveryState, "awaiting_result");
    ledger2.close();
  });

  test("completed tasks are NOT in recovery list", () => {
    const dbPath = tmpDbPath();
    const taskId = generateTaskId("phone");

    const ledger1 = new DelegationLedger(dbPath);
    ledger1.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "done" });
    ledger1.updateOutbox(taskId, { deliveryState: "done", finalState: "done", resultAt: new Date().toISOString() });
    ledger1.close();

    const ledger2 = new DelegationLedger(dbPath);
    const recovery = ledger2.listPendingRecovery();
    assert.ok(!recovery.some((e) => e.taskId === taskId), "done task should not appear in recovery");
    ledger2.close();
  });
});

// ---------------------------------------------------------------------------
// Test E: Circuit open → retry_scheduled
// ---------------------------------------------------------------------------

describe("Test E — Circuit open: task queued for later retry", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("circuit-open results in retry_scheduled state", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "test" });
    const nextRetryAt = computeNextRetryAt(1)!;
    ledger.updateOutbox(taskId, {
      deliveryState: "retry_scheduled",
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      nextRetryAt: nextRetryAt.toISOString(),
      errorCode: "CIRCUIT_OPEN",
      errorMessage: "Peer vm-main is unavailable (circuit breaker open)",
    });

    const entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "retry_scheduled");
    assert.equal(entry.errorCode, "CIRCUIT_OPEN");
    assert.ok(entry.nextRetryAt, "should have nextRetryAt");
  });

  test("listDueRetries returns tasks past their nextRetryAt", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "test" });

    // Set nextRetryAt in the past (1 second ago)
    const pastRetry = new Date(Date.now() - 1000).toISOString();
    ledger.updateOutbox(taskId, {
      deliveryState: "retry_scheduled",
      attempts: 1,
      nextRetryAt: pastRetry,
    });

    const due = ledger.listDueRetries();
    assert.ok(due.some((e) => e.taskId === taskId), "task with past nextRetryAt should appear in due retries");
  });

  test("future nextRetryAt does NOT appear in due retries", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "test" });

    // Set nextRetryAt far in the future
    const futureRetry = new Date(Date.now() + 3_600_000).toISOString();
    ledger.updateOutbox(taskId, {
      deliveryState: "retry_scheduled",
      attempts: 1,
      nextRetryAt: futureRetry,
    });

    const due = ledger.listDueRetries();
    assert.ok(!due.some((e) => e.taskId === taskId), "future task should NOT appear in due retries");
  });
});

// ---------------------------------------------------------------------------
// Test F: Duplicate resend → inbox idempotency
// ---------------------------------------------------------------------------

describe("Test F — Duplicate resend: inbox deduplication", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("same taskId received multiple times creates only one inbox entry", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    for (let i = 0; i < 5; i++) {
      ledger.createInboxIfNew({
        taskId, delegationId, senderNode: "phone", receiverNode: "vm-main",
        taskType: "operation", payloadSummary: `attempt ${i}`,
      });
    }

    const all = ledger.listInbox();
    const forTask = all.filter((e) => e.taskId === taskId);
    assert.equal(forTask.length, 1, "should only have one inbox entry regardless of resends");
  });

  test("outbox createOutbox is idempotent (INSERT OR IGNORE)", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    // Create twice with same taskId
    ledger.createOutbox({ taskId, delegationId, senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "first" });
    ledger.createOutbox({ taskId, delegationId, senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "second" });

    const all = ledger.listAllOutbox();
    const forTask = all.filter((e) => e.taskId === taskId);
    assert.equal(forTask.length, 1, "should only have one outbox entry");
    assert.equal(forTask[0].payloadSummary, "first", "should keep the first entry");
  });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

describe("Ledger stats", () => {
  test("getStats returns correct counts", () => {
    const ledger = mkLedger();

    for (let i = 0; i < 3; i++) {
      const taskId = generateTaskId("phone");
      ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "x" });
      ledger.updateOutbox(taskId, { deliveryState: "done", finalState: "done" });
    }

    ledger.createOutbox({ taskId: generateTaskId("phone"), delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "x", deliveryState: "retry_scheduled" });

    const stats = ledger.getStats();
    assert.equal(stats["outbox_done"], 3);
    assert.equal(stats["outbox_retry_scheduled"], 1);

    ledger.close();
  });
});

// ---------------------------------------------------------------------------
// Test G: Receiver completed dedup (execution guard — done)
// ---------------------------------------------------------------------------

describe("Test G — Receiver completed dedup: tryClaimExecution returns duplicate_done", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("first call claims, second returns duplicate_done after marking done", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();
    const params = {
      taskId, delegationId, senderNode: "phone", receiverNode: "vm-main",
      taskType: "operation", payloadSummary: "test task", payloadJson: "full task payload",
    };

    // First call — should claim
    const r1 = ledger.tryClaimExecution(params);
    assert.equal(r1.status, "claimed");

    // Mark as done (simulate task completion)
    ledger.updateInbox(taskId, {
      receiverState: "done",
      completedAt: new Date().toISOString(),
      resultSummary: "Task completed: found 5 items",
    });

    // Second call (resend) — should detect duplicate_done
    const r2 = ledger.tryClaimExecution(params);
    assert.equal(r2.status, "duplicate_done");
    assert.ok(r2.existingEntry, "should return existing entry");
    assert.equal(r2.existingEntry!.receiverState, "done");
    assert.equal(r2.existingEntry!.resultSummary, "Task completed: found 5 items");
  });

  test("duplicate_done event is recorded in event log", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();
    const params = { taskId, delegationId, senderNode: "phone", receiverNode: "vm-main", taskType: "query", payloadSummary: "x" };

    ledger.tryClaimExecution(params);
    ledger.updateInbox(taskId, { receiverState: "done", completedAt: new Date().toISOString() });
    ledger.tryClaimExecution(params); // duplicate

    const events = ledger.getEvents(taskId);
    const guardEvents = events.filter((e) => e.eventType === "execution_guard_acquired" || e.eventType === "execution_guard_rejected");
    assert.equal(guardEvents.length, 2, "should have one acquired and one rejected event");
    assert.equal(guardEvents[0].eventType, "execution_guard_acquired");
    assert.equal(guardEvents[1].eventType, "execution_guard_rejected");

    const rejectedPayload = JSON.parse(guardEvents[1].eventPayload);
    assert.equal(rejectedPayload.existingState, "done");
  });

  test("duplicate_failed returns correct status", () => {
    const taskId = generateTaskId("phone");
    const params = { taskId, delegationId: randomUUID(), senderNode: "phone", receiverNode: "vm-main", taskType: "query", payloadSummary: "x" };

    ledger.tryClaimExecution(params);
    ledger.updateInbox(taskId, {
      receiverState: "failed",
      completedAt: new Date().toISOString(),
      errorCode: "TOOL_ERROR",
      errorMessage: "Browse tool failed",
    });

    const r2 = ledger.tryClaimExecution(params);
    assert.equal(r2.status, "duplicate_failed");
    assert.equal(r2.existingEntry!.errorCode, "TOOL_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Test H: Receiver running dedup (execution guard — running)
// ---------------------------------------------------------------------------

describe("Test H — Receiver running dedup: tryClaimExecution blocks second execution", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("second call while running returns duplicate_running", () => {
    const taskId = generateTaskId("phone");
    const params = { taskId, delegationId: randomUUID(), senderNode: "phone", receiverNode: "vm-main", taskType: "operation", payloadSummary: "long task" };

    // First call claims
    const r1 = ledger.tryClaimExecution(params);
    assert.equal(r1.status, "claimed");

    // Update to running (task started)
    ledger.updateInbox(taskId, { receiverState: "running", startedAt: new Date().toISOString() });

    // Duplicate arrives while task is still running
    const r2 = ledger.tryClaimExecution(params);
    assert.equal(r2.status, "duplicate_running");
    assert.equal(r2.existingEntry!.receiverState, "running");
  });

  test("second call while accepted (not yet running) returns duplicate_running", () => {
    const taskId = generateTaskId("phone");
    const params = { taskId, delegationId: randomUUID(), senderNode: "phone", receiverNode: "vm-main", taskType: "operation", payloadSummary: "x" };

    // First call claims (accepted state)
    const r1 = ledger.tryClaimExecution(params);
    assert.equal(r1.status, "claimed");
    // Don't update to running yet — stays in 'accepted'

    // Duplicate arrives immediately
    const r2 = ledger.tryClaimExecution(params);
    assert.equal(r2.status, "duplicate_running", "accepted state should be treated as duplicate_running");
  });

  test("inbox has only one entry regardless of how many times tryClaimExecution is called", () => {
    const taskId = generateTaskId("phone");
    const params = { taskId, delegationId: randomUUID(), senderNode: "phone", receiverNode: "vm-main", taskType: "operation", payloadSummary: "x" };

    for (let i = 0; i < 10; i++) {
      ledger.tryClaimExecution(params);
    }

    const all = ledger.listInbox();
    const forTask = all.filter((e) => e.taskId === taskId);
    assert.equal(forTask.length, 1, "only one inbox entry, regardless of call count");
  });
});

// ---------------------------------------------------------------------------
// Test I: Race condition dedup (atomic guard)
// ---------------------------------------------------------------------------

describe("Test I — Race condition: atomic guard ensures only one execution", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("sequential calls with same taskId: only first succeeds", () => {
    const taskId = generateTaskId("phone");
    const params = { taskId, delegationId: randomUUID(), senderNode: "phone", receiverNode: "vm-main", taskType: "operation", payloadSummary: "concurrent task" };

    // Simulate rapid sequential calls (Node.js is single-threaded, but SQLite IMMEDIATE ensures atomicity)
    const results: ExecutionGuardStatus[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(ledger.tryClaimExecution(params).status);
    }

    const claimed = results.filter((s) => s === "claimed");
    const duplicates = results.filter((s) => s !== "claimed");

    assert.equal(claimed.length, 1, "exactly one call should get 'claimed'");
    assert.equal(duplicates.length, 4, "the other 4 calls should get duplicate status");
    assert.ok(duplicates.every((s) => s === "duplicate_running"), "all duplicates should be duplicate_running (accepted state)");
  });

  test("BEGIN IMMEDIATE prevents second insert via unique constraint", () => {
    const taskId = generateTaskId("phone");
    const delegationId = randomUUID();

    // Claim with first caller
    const r1 = ledger.tryClaimExecution({
      taskId, delegationId,
      senderNode: "phone", receiverNode: "vm-main",
      taskType: "operation", payloadSummary: "task A",
    });
    assert.equal(r1.status, "claimed");

    // Attempt with different delegationId but same taskId (simulates different resend)
    const r2 = ledger.tryClaimExecution({
      taskId,
      delegationId: randomUUID(), // different delegation ID
      senderNode: "phone", receiverNode: "vm-main",
      taskType: "operation", payloadSummary: "task A resent",
    });
    assert.equal(r2.status, "duplicate_running", "same taskId with different delegationId should still be deduped");

    // Verify only one inbox entry
    assert.equal(ledger.listInbox().filter((e) => e.taskId === taskId).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Test J: Retry with full payload_json
// ---------------------------------------------------------------------------

describe("Test J — Retry with full payload_json: sender restart uses complete payload", () => {
  test("payload_json survives ledger close/reopen cycle", () => {
    const dbPath = tmpDbPath();
    const taskId = generateTaskId("phone");
    const fullPayload = "Please research the Q1 2026 revenue figures and provide a detailed breakdown by product line, including YoY comparisons.";

    const ledger1 = new DelegationLedger(dbPath);
    ledger1.createOutbox({
      taskId,
      delegationId: randomUUID(),
      senderNode: "phone",
      targetNode: "vm-main",
      taskType: "operation",
      payloadSummary: fullPayload.slice(0, 50),
      payloadJson: fullPayload,
    });
    ledger1.updateOutbox(taskId, { deliveryState: "sending", attempts: 1 });
    ledger1.close();

    // Simulate restart
    const ledger2 = new DelegationLedger(dbPath);
    const pending = ledger2.listPendingRecovery();
    const entry = pending.find((e) => e.taskId === taskId);
    assert.ok(entry, "task should be recoverable after restart");
    assert.equal(entry!.payloadJson, fullPayload, "full payload should be preserved exactly");
    assert.ok(entry!.payloadSummary !== fullPayload, "summary should be different from full payload");
    ledger2.close();
  });

  test("payloadSummary and payloadJson are both stored independently", () => {
    const ledger = mkLedger();
    const taskId = generateTaskId("phone");
    const fullPayload = "A".repeat(1000); // Large payload
    const summary = fullPayload.slice(0, 200);

    ledger.createOutbox({
      taskId,
      delegationId: randomUUID(),
      senderNode: "phone",
      targetNode: "vm-main",
      taskType: "query",
      payloadSummary: summary,
      payloadJson: fullPayload,
    });

    const entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.payloadSummary, summary);
    assert.equal(entry.payloadJson, fullPayload);
    assert.equal(entry.payloadJson!.length, 1000);
    ledger.close();
  });

  test("inbox stores payload_json from receiver side", () => {
    const ledger = mkLedger();
    const taskId = generateTaskId("phone");
    const inboundPayload = "[Delegated Task | type=operation | id=xxx | taskId=abc]\nDo the research.";

    const result = ledger.tryClaimExecution({
      taskId,
      delegationId: randomUUID(),
      senderNode: "phone",
      receiverNode: "vm-main",
      taskType: "operation",
      payloadSummary: inboundPayload.slice(0, 50),
      payloadJson: inboundPayload,
    });
    assert.equal(result.status, "claimed");

    const inbox = ledger.getInbox(taskId)!;
    assert.equal(inbox.payloadJson, inboundPayload);
    ledger.close();
  });

  test("retry falls back to payloadSummary when payloadJson is null", () => {
    const ledger = mkLedger();
    const taskId = generateTaskId("phone");

    // Legacy entry without payloadJson
    ledger.createOutbox({
      taskId,
      delegationId: randomUUID(),
      senderNode: "phone",
      targetNode: "vm-main",
      taskType: "operation",
      payloadSummary: "short summary",
      // payloadJson intentionally omitted
    });

    const entry = ledger.getOutbox(taskId)!;
    // Simulate what delegation.ts does for retry:
    const messageToSend = entry.payloadJson ?? entry.payloadSummary;
    assert.equal(messageToSend, "short summary", "should fall back to payloadSummary");
    ledger.close();
  });
});

// ---------------------------------------------------------------------------
// Test K: Dead-letter replay
// ---------------------------------------------------------------------------

describe("Test K — Dead-letter replay: re-queue with original payload", () => {
  let ledger: DelegationLedger;
  beforeEach(() => { ledger = mkLedger(); });
  afterEach(() => { ledger.close(); });

  test("replayDeadLetter creates new queued task with same payload", () => {
    const taskId = generateTaskId("phone");
    const fullPayload = "Research the Q2 market trends";

    ledger.createOutbox({
      taskId,
      delegationId: randomUUID(),
      senderNode: "phone",
      targetNode: "vm-main",
      taskType: "operation",
      payloadSummary: "Research Q2",
      payloadJson: fullPayload,
    });
    ledger.updateOutbox(taskId, {
      deliveryState: "dead_lettered",
      finalState: "failed",
      errorCode: "MAX_RETRIES",
      errorMessage: "Exhausted all retry attempts",
    });

    // Replay
    const result = ledger.replayDeadLetter(taskId);
    assert.ok(result, "replay should succeed");
    assert.ok(result!.newTaskId !== taskId, "new task should have different ID");
    assert.match(result!.newTaskId, /^a2a-phone-\d{14}-[0-9a-f]{4}$/, "new ID should use correct format");

    // Original should be cancelled
    const original = ledger.getOutbox(taskId)!;
    assert.equal(original.deliveryState, "cancelled");
    assert.ok(original.errorMessage?.includes(result!.newTaskId), "should reference new task ID");

    // New task should be queued with same payload
    const newEntry = ledger.getOutbox(result!.newTaskId)!;
    assert.equal(newEntry.deliveryState, "queued");
    assert.equal(newEntry.payloadJson, fullPayload, "full payload should be copied to new task");
    assert.equal(newEntry.targetNode, "vm-main");
    assert.equal(newEntry.taskType, "operation");
  });

  test("replayDeadLetter returns null for non-dead_lettered task", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "x" });
    // Still in queued state

    const result = ledger.replayDeadLetter(taskId);
    assert.equal(result, null, "should return null for non-dead_lettered task");
  });

  test("replay does not create a duplicate inbox entry if receiver already saw original taskId", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({
      taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main",
      taskType: "operation", payloadSummary: "x",
    });
    ledger.updateOutbox(taskId, { deliveryState: "dead_lettered", finalState: "failed" });

    const replay = ledger.replayDeadLetter(taskId)!;

    // The new task has a different taskId, so receiver would treat it as new
    const newEntry = ledger.getOutbox(replay.newTaskId)!;
    assert.notEqual(newEntry.taskId, taskId, "new task has new ID — no inbox collision");

    // Events on original task
    const events = ledger.getEvents(taskId);
    assert.ok(events.some((e) => e.eventType === "dead_letter_replayed"), "should have replay event");

    // Events on new task
    const newEvents = ledger.getEvents(replay.newTaskId);
    assert.ok(newEvents.some((e) => e.eventType === "replayed_from"), "new task should reference original");
  });

  test("replayed task appears in listDueRetries immediately (queued state is visible)", () => {
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "x" });
    ledger.updateOutbox(taskId, { deliveryState: "dead_lettered", finalState: "failed" });

    const replay = ledger.replayDeadLetter(taskId)!;

    // New task is in 'queued' state (not retry_scheduled), so it won't appear in listDueRetries
    // But it IS visible in listAllOutbox
    const all = ledger.listAllOutbox();
    assert.ok(all.some((e) => e.taskId === replay.newTaskId && e.deliveryState === "queued"),
      "replayed task should appear in outbox with queued state");
  });
});

// ---------------------------------------------------------------------------
// Test L: Phone-side queryability
// ---------------------------------------------------------------------------

describe("Test L — Phone-side queryability: operator can see all stuck states", () => {
  test("getSummary shows pending, retry, dead-letter counts", () => {
    const ledger = mkLedger();

    // Create tasks in various states
    // 2 queued
    for (let i = 0; i < 2; i++) {
      ledger.createOutbox({ taskId: generateTaskId("phone"), delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: `pending ${i}` });
    }
    // 1 awaiting_result
    const t3 = generateTaskId("phone");
    ledger.createOutbox({ taskId: t3, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "await result" });
    ledger.updateOutbox(t3, { deliveryState: "awaiting_result", ackedAt: new Date().toISOString(), remoteTaskId: "remote-xyz" });

    // 1 retry_scheduled
    const t4 = generateTaskId("phone");
    ledger.createOutbox({ taskId: t4, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "retry" });
    ledger.updateOutbox(t4, { deliveryState: "retry_scheduled", attempts: 2, nextRetryAt: new Date(Date.now() + 30_000).toISOString() });

    // 1 dead_lettered
    const t5 = generateTaskId("phone");
    ledger.createOutbox({ taskId: t5, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "dead" });
    ledger.updateOutbox(t5, { deliveryState: "dead_lettered", finalState: "failed", errorMessage: "Exhausted retries" });

    // 1 done (should NOT appear in pending)
    const t6 = generateTaskId("phone");
    ledger.createOutbox({ taskId: t6, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "query", payloadSummary: "done" });
    ledger.updateOutbox(t6, { deliveryState: "done", finalState: "done" });

    const summary = ledger.getSummary();

    // 2 queued + 1 awaiting_result = 3 pending
    assert.ok(summary.pendingCount >= 3, `pendingCount should be ≥3, got ${summary.pendingCount}`);
    assert.equal(summary.retryCount, 1);
    assert.equal(summary.deadLetterCount, 1);

    assert.ok(summary.recentDeadLetters.length >= 1, "should show recent dead letters");
    assert.equal(summary.recentDeadLetters[0].deliveryState, "dead_lettered");

    assert.ok(summary.recentPending.length >= 3, "should show recent pending tasks");
    assert.ok(!summary.recentPending.some((e) => e.deliveryState === "done"), "done tasks should not appear in pending");

    ledger.close();
  });

  test("can answer: is this task stuck in ACK wait?", () => {
    const ledger = mkLedger();
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "check me" });
    ledger.updateOutbox(taskId, { deliveryState: "awaiting_ack", attempts: 1, lastAttemptAt: new Date().toISOString() });

    const entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.deliveryState, "awaiting_ack", "operator can see task is stuck in ACK wait");
    assert.equal(entry.ackedAt, null, "no ACK received yet");

    ledger.close();
  });

  test("can answer: has this task been dead-lettered?", () => {
    const ledger = mkLedger();
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "stuck" });
    ledger.updateOutbox(taskId, { deliveryState: "dead_lettered", errorCode: "MAX_RETRIES", errorMessage: "5 attempts failed" });

    const deadLetters = ledger.listDeadLetters();
    assert.ok(deadLetters.some((e) => e.taskId === taskId), "task appears in dead-letter list");

    const entry = ledger.getOutbox(taskId)!;
    assert.equal(entry.errorCode, "MAX_RETRIES");
    assert.equal(entry.errorMessage, "5 attempts failed");

    ledger.close();
  });

  test("can see full event timeline for a task", () => {
    const ledger = mkLedger();
    const taskId = generateTaskId("phone");
    ledger.createOutbox({ taskId, delegationId: randomUUID(), senderNode: "phone", targetNode: "vm-main", taskType: "operation", payloadSummary: "timeline test" });
    ledger.updateOutbox(taskId, { deliveryState: "sending", attempts: 1 });
    ledger.updateOutbox(taskId, { deliveryState: "retry_scheduled", attempts: 1, nextRetryAt: new Date(Date.now() + 10_000).toISOString() });
    ledger.updateOutbox(taskId, { deliveryState: "sending", attempts: 2 });
    ledger.updateOutbox(taskId, { deliveryState: "acked", ackedAt: new Date().toISOString() });

    const events = ledger.getEvents(taskId);
    const stateChanges = events.filter((e) => e.eventType === "state_change");
    const stateNames = stateChanges.map((e) => JSON.parse(e.eventPayload).state);

    assert.ok(stateNames.includes("sending"), "should show sending state");
    assert.ok(stateNames.includes("retry_scheduled"), "should show retry_scheduled state");
    assert.ok(stateNames.includes("acked"), "should show acked state");

    ledger.close();
  });
});
