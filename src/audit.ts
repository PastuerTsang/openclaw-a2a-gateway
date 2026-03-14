/**
 * A2A Gateway — Audit Logger
 *
 * Append-only structured audit log for inbound/outbound A2A calls.
 * Records: who / when / peer / taskId / action / result.
 *
 * Each audit entry is one JSON line per record, written to a daily log file.
 */

import fs from "node:fs";
import path from "node:path";

export interface AuditEntry {
  ts: string;
  action: "inbound" | "outbound" | "auth_rejected" | "file_send" | "task_state_change" | "push_notification" | "learning_sync_receive" | "learning_sync_cycle";
  peer?: string;
  taskId?: string;
  contextId?: string;
  agentId?: string;
  method?: string;
  statusCode?: number;
  ok?: boolean;
  durationMs?: number;
  detail?: string;
}

export class AuditLogger {
  private readonly auditDir: string;
  private dirReady: Promise<void> | null = null;

  constructor(auditDir: string) {
    this.auditDir = auditDir;
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.ensureDir();
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(this.auditDir, `audit-${date}.jsonl`);
    const line = JSON.stringify(entry) + "\n";
    await fs.promises.appendFile(filePath, line, "utf-8");
  }

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = fs.promises.mkdir(this.auditDir, { recursive: true }).then(() => {});
    }
    return this.dirReady;
  }
}
