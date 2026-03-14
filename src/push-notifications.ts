/**
 * A2A Gateway — Push Notification Support
 *
 * Implements A2A push notifications (webhook callbacks):
 * - Clients register a callback URL for a task
 * - When the task transitions to a terminal state, the gateway POSTs the task to the callback URL
 * - Supports retry with exponential backoff for failed deliveries
 */

import type { PushNotificationConfig } from "./types.js";

export interface PushCallback {
  taskId: string;
  url: string;
  /** Optional authentication token sent as Bearer in webhook delivery. */
  token?: string;
  registeredAt: number;
}

interface DeliveryAttempt {
  callback: PushCallback;
  payload: unknown;
  attempt: number;
}

type LoggerLike = {
  info(msg: string): void;
  warn(msg: string): void;
};

export class PushNotificationManager {
  private readonly callbacks: Map<string, PushCallback[]> = new Map();
  private readonly config: PushNotificationConfig;
  private readonly logger: LoggerLike;
  private readonly onDelivery?: (taskId: string, url: string, ok: boolean) => void;

  constructor(
    config: PushNotificationConfig,
    logger: LoggerLike,
    onDelivery?: (taskId: string, url: string, ok: boolean) => void,
  ) {
    this.config = config;
    this.logger = logger;
    this.onDelivery = onDelivery;
  }

  /** Register a push notification callback for a task. */
  register(taskId: string, url: string, token?: string): { ok: boolean; reason?: string } {
    if (!this.config.enabled) {
      return { ok: false, reason: "Push notifications are not enabled" };
    }

    // Validate URL
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, reason: "Callback URL must use http or https" };
      }
    } catch {
      return { ok: false, reason: "Invalid callback URL" };
    }

    const existing = this.callbacks.get(taskId) || [];
    if (existing.length >= this.config.maxCallbacksPerTask) {
      return { ok: false, reason: `Maximum callbacks per task reached (${this.config.maxCallbacksPerTask})` };
    }

    // Avoid duplicate URLs for the same task
    if (existing.some((cb) => cb.url === url)) {
      return { ok: true }; // Already registered — idempotent
    }

    existing.push({ taskId, url, token, registeredAt: Date.now() });
    this.callbacks.set(taskId, existing);
    return { ok: true };
  }

  /** Unregister a push notification callback for a task. */
  unregister(taskId: string, url: string): boolean {
    const existing = this.callbacks.get(taskId);
    if (!existing) return false;

    const filtered = existing.filter((cb) => cb.url !== url);
    if (filtered.length === existing.length) return false;

    if (filtered.length === 0) {
      this.callbacks.delete(taskId);
    } else {
      this.callbacks.set(taskId, filtered);
    }
    return true;
  }

  /** Get registered callbacks for a task. */
  getCallbacks(taskId: string): PushCallback[] {
    return this.callbacks.get(taskId) || [];
  }

  /** Notify all registered callbacks for a task state change. */
  async notifyTaskUpdate(taskId: string, taskPayload: unknown): Promise<void> {
    const callbacks = this.callbacks.get(taskId);
    if (!callbacks || callbacks.length === 0) return;

    const deliveries = callbacks.map((cb) => this.deliver({ callback: cb, payload: taskPayload, attempt: 0 }));
    await Promise.allSettled(deliveries);
  }

  /** Clean up callbacks for a deleted/expired task. */
  cleanup(taskId: string): void {
    this.callbacks.delete(taskId);
  }

  private async deliver(delivery: DeliveryAttempt): Promise<void> {
    const { callback, payload, attempt } = delivery;

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (callback.token) {
        headers.authorization = `Bearer ${callback.token}`;
      }

      const response = await fetch(callback.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        this.onDelivery?.(callback.taskId, callback.url, true);
        return;
      }

      // Non-2xx: retry
      if (attempt < this.config.maxDeliveryRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.deliver({ ...delivery, attempt: attempt + 1 });
      }

      this.logger.warn(
        `a2a-gateway: push notification delivery failed after ${attempt + 1} attempts to ${callback.url} for task ${callback.taskId}`,
      );
      this.onDelivery?.(callback.taskId, callback.url, false);
    } catch (err: unknown) {
      if (attempt < this.config.maxDeliveryRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.deliver({ ...delivery, attempt: attempt + 1 });
      }

      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `a2a-gateway: push notification delivery error for task ${callback.taskId}: ${msg}`,
      );
      this.onDelivery?.(callback.taskId, callback.url, false);
    }
  }
}
