/**
 * A2A Delegation Reliability Layer — Test Suite
 *
 * Covers spec test scenarios A-F:
 *   A. Normal delegation (queued → acked → done)
 *   B. ACK timeout → retry → receiver deduplication
 *   C. Receiver restart recovery (awaiting_result → resume)
 *   D. Sender restart recovery (outbox preserved)
 *   E. Circuit open → retry_scheduled → queued visible
 *   F. Duplicate resend → inbox deduplication
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
