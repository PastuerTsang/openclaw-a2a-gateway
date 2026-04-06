/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json  (Agent Card discovery)
 * - /a2a/jsonrpc              (JSON-RPC transport)
 * - /a2a/rest                 (REST transport)
 * - gRPC on port+1            (gRPC transport)
 */

import type { Server } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import { DefaultRequestHandler } from "@a2a-js/sdk/server";
import { UserBuilder, agentCardHandler, jsonRpcHandler, restHandler } from "@a2a-js/sdk/server/express";
import { grpcService, A2AService, UserBuilder as GrpcUserBuilder } from "@a2a-js/sdk/server/grpc";
import { Server as GrpcServer, ServerCredentials, status as GrpcStatus } from "@grpc/grpc-js";
import express from "express";

import { buildAgentCard } from "./src/agent-card.js";
import { A2AClient } from "./src/client.js";
import { OpenClawAgentExecutor } from "./src/executor.js";
import { QueueingAgentExecutor } from "./src/queueing-executor.js";
import { runTaskCleanup } from "./src/task-cleanup.js";
import { FileTaskStore } from "./src/task-store.js";
import { GatewayTelemetry } from "./src/telemetry.js";
import type {
  AgentCardConfig,
  DelegationConfig,
  DelegationPolicyRule,
  DelegationTaskType,
  GatewayConfig,
  InboundAuth,
  LearningSyncGatewayConfig,
  MemoryQueryRequest,
  MemoryQueryResponse,
  OpenClawPluginApi,
  PeerConfig,
  RoutingRuleConfig,
} from "./src/types.js";
import { LearningSyncManager, MERGE_VERSION, type MemoryFileEntry } from "./src/learning-sync.js";
import {
  validateUri,
  validateMimeType,
} from "./src/file-security.js";
import { AuditLogger } from "./src/audit.js";
import { PeerHealthTracker, withRetry } from "./src/peer-health.js";
import { PushNotificationManager } from "./src/push-notifications.js";
import { DelegationManager } from "./src/delegation.js";

/** Build a JSON-RPC error response. */
function jsonRpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }

  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function normalizeHttpPath(value: string, fallback: string): string {
  const trimmed = value.trim() || fallback;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveConfiguredPath(
  value: unknown,
  fallback: string,
  resolvePath?: (nextPath: string) => string,
): string {
  const configured = asString(value, "").trim() || fallback;
  const resolved = resolvePath ? resolvePath(configured) : configured;
  return path.isAbsolute(resolved) ? resolved : path.resolve(resolved);
}

function parseAgentCard(raw: Record<string, unknown>): AgentCardConfig {
  const skills = Array.isArray(raw.skills) ? raw.skills : [];

  return {
    name: asString(raw.name, "OpenClaw A2A Gateway"),
    description: asString(raw.description, "A2A bridge for OpenClaw agents"),
    url: asString(raw.url, ""),
    skills: skills.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const skill = asObject(entry);
      return {
        id: asString(skill.id, ""),
        name: asString(skill.name, "unknown"),
        description: asString(skill.description, ""),
      };
    }),
  };
}

function parsePeers(raw: unknown): PeerConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const peers: PeerConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const name = asString(value.name, "");
    const agentCardUrl = asString(value.agentCardUrl, "");
    if (!name || !agentCardUrl) {
      continue;
    }

    const authRaw = asObject(value.auth);
    const authTypeRaw = asString(authRaw.type, "");
    const authType = authTypeRaw === "bearer" || authTypeRaw === "apiKey" ? authTypeRaw : "";
    const token = asString(authRaw.token, "");

    peers.push({
      name,
      agentCardUrl,
      auth: authType && token ? { type: authType, token } : undefined,
    });
  }

  return peers;
}

function parseRoutingRules(raw: unknown): RoutingRuleConfig[] {
  if (!Array.isArray(raw)) return [];
  const rules: RoutingRuleConfig[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const routeKey = asString(value.routeKey, "");
    const agentId = asString(value.agentId, "");
    if (!routeKey || !agentId) continue;
    rules.push({
      routeKey,
      agentId,
      peer: asString(value.peer, "") || undefined,
    });
  }
  return rules;
}

const VALID_DELEGATION_TASK_TYPES = new Set<DelegationTaskType>(["query", "device", "operation", "custom"]);

function parseDelegationPolicy(raw: unknown): DelegationPolicyRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: DelegationPolicyRule[] = [];
  for (const entry of raw) {
    const value = asObject(entry);
    const peer = asString(value.peer, "");
    if (!peer) continue;
    const rawTypes = Array.isArray(value.allowedTaskTypes) ? value.allowedTaskTypes : [];
    const allowedTaskTypes = (rawTypes
      .filter((t: unknown) => typeof t === "string" && VALID_DELEGATION_TASK_TYPES.has(t as DelegationTaskType))
    ) as DelegationTaskType[];
    if (allowedTaskTypes.length === 0) continue;
    const maxConcurrent = typeof value.maxConcurrent === "number" && value.maxConcurrent > 0
      ? Math.floor(value.maxConcurrent) : undefined;
    rules.push({ peer, allowedTaskTypes, maxConcurrent });
  }
  return rules;
}

function parseConfig(raw: unknown, resolvePath?: (nextPath: string) => string): GatewayConfig {
  const config = asObject(raw);
  const server = asObject(config.server);
  const storage = asObject(config.storage);
  const security = asObject(config.security);
  const routing = asObject(config.routing);
  const limits = asObject(config.limits);
  const observability = asObject(config.observability);
  const timeouts = asObject(config.timeouts);
  const resilience = asObject(config.resilience);
  const pushNotifications = asObject(config.pushNotifications);
  const learningSync = asObject(config.learningSync);
  const delegation = asObject(config.delegation);
  const memoryQuery = asObject(config.memoryQuery);

  const inboundAuth = asString(security.inboundAuth, "none") as InboundAuth;

  const defaultMimeTypes = [
    "image/*", "application/pdf", "text/plain", "text/csv",
    "application/json", "audio/*", "video/*",
  ];
  const rawAllowedMime = Array.isArray(security.allowedMimeTypes) ? security.allowedMimeTypes : [];
  const allowedMimeTypes = rawAllowedMime.length > 0
    ? rawAllowedMime.filter((v: unknown) => typeof v === "string") as string[]
    : defaultMimeTypes;
  const rawUriAllowlist = Array.isArray(security.fileUriAllowlist) ? security.fileUriAllowlist : [];
  const fileUriAllowlist = rawUriAllowlist.filter((v: unknown) => typeof v === "string") as string[];

  // Token rotation: accept both singular token and tokens array
  const rawTokens = Array.isArray(security.tokens) ? security.tokens : [];
  const tokens = rawTokens.filter((v: unknown) => typeof v === "string" && v.trim()) as string[];

  return {
    agentCard: parseAgentCard(asObject(config.agentCard)),
    server: {
      host: asString(server.host, "0.0.0.0"),
      port: asNumber(server.port, 18800),
    },
    storage: {
      tasksDir: resolveConfiguredPath(storage.tasksDir, "data/tasks", resolvePath),
      taskTtlHours: Math.max(1, asNumber(storage.taskTtlHours, 72)),
      cleanupIntervalMinutes: Math.max(1, asNumber(storage.cleanupIntervalMinutes, 60)),
      auditDir: resolveConfiguredPath(storage.auditDir, "data/audit", resolvePath),
    },
    peers: parsePeers(config.peers),
    security: {
      inboundAuth: inboundAuth === "bearer" ? "bearer" : "none",
      token: asString(security.token, ""),
      tokens,
      allowedMimeTypes,
      maxFileSizeBytes: asNumber(security.maxFileSizeBytes, 52_428_800),
      maxInlineFileSizeBytes: asNumber(security.maxInlineFileSizeBytes, 10_485_760),
      fileUriAllowlist,
    },
    routing: {
      defaultAgentId: asString(routing.defaultAgentId, "default"),
      rules: parseRoutingRules(routing.rules),
    },
    limits: {
      maxConcurrentTasks: Math.max(1, Math.floor(asNumber(limits.maxConcurrentTasks, 4))),
      maxQueuedTasks: Math.max(0, Math.floor(asNumber(limits.maxQueuedTasks, 100))),
    },
    observability: {
      structuredLogs: asBoolean(observability.structuredLogs, true),
      exposeMetricsEndpoint: asBoolean(observability.exposeMetricsEndpoint, true),
      metricsPath: normalizeHttpPath(asString(observability.metricsPath, "/a2a/metrics"), "/a2a/metrics"),
    },
    timeouts: {
      agentResponseTimeoutMs: asNumber(timeouts.agentResponseTimeoutMs, 300_000),
    },
    resilience: {
      healthCheckIntervalSeconds: Math.max(10, asNumber(resilience.healthCheckIntervalSeconds, 60)),
      circuitBreakerThreshold: Math.max(1, asNumber(resilience.circuitBreakerThreshold, 5)),
      circuitBreakerCooldownSeconds: Math.max(5, asNumber(resilience.circuitBreakerCooldownSeconds, 30)),
      maxRetries: Math.max(0, asNumber(resilience.maxRetries, 3)),
    },
    pushNotifications: {
      enabled: asBoolean(pushNotifications.enabled, false),
      maxCallbacksPerTask: Math.max(1, asNumber(pushNotifications.maxCallbacksPerTask, 5)),
      maxDeliveryRetries: Math.max(0, asNumber(pushNotifications.maxDeliveryRetries, 3)),
    },
    learningSync: {
      enabled: asBoolean(learningSync.enabled, false),
      memoryDir: resolveConfiguredPath(
        learningSync.memoryDir,
        path.join(process.env.OPENCLAW_HOME || path.join(process.env.HOME || "/root", ".openclaw"), "workspace", "memory"),
        resolvePath,
      ),
      instanceName: asString(learningSync.instanceName, "") || os.hostname(),
      autoSyncIntervalSeconds: Math.max(0, asNumber(learningSync.autoSyncIntervalSeconds, 300)),
      excludeFiles: Array.isArray(learningSync.excludeFiles)
        ? learningSync.excludeFiles.filter((f: unknown) => typeof f === "string") as string[]
        : [],
    },
    delegation: {
      enabled: asBoolean(delegation.enabled, false),
      policy: parseDelegationPolicy(delegation.policy),
      defaultTimeoutMs: Math.max(1000, asNumber(delegation.defaultTimeoutMs, 120_000)),
      pollIntervalMs: Math.max(500, asNumber(delegation.pollIntervalMs, 2_000)),
      maxPollAttempts: Math.max(1, asNumber(delegation.maxPollAttempts, 60)),
    },
    memoryQuery: {
      enabled: asBoolean(memoryQuery.enabled, asBoolean(learningSync.enabled, false)),
      maxResults: Math.min(50, Math.max(1, asNumber(memoryQuery.maxResults, 10))),
      maxTotalChars: Math.max(500, asNumber(memoryQuery.maxTotalChars, 8000)),
      rateLimitPerMinute: Math.max(1, asNumber(memoryQuery.rateLimitPerMinute, 10)),
      deduplicateSyncedWithinSeconds: Math.max(0, asNumber(memoryQuery.deduplicateSyncedWithinSeconds, 0)),
    },
  };
}

function normalizeCardPath(): string {
  if (AGENT_CARD_PATH.startsWith("/")) {
    return AGENT_CARD_PATH;
  }

  return `/${AGENT_CARD_PATH}`;
}

const plugin = {
  id: "a2a-gateway",
  name: "A2A Gateway",
  description: "OpenClaw plugin that serves A2A v0.3.0 endpoints",

  register(api: OpenClawPluginApi) {
    const config = parseConfig(api.pluginConfig, api.resolvePath?.bind(api));
    const telemetry = new GatewayTelemetry(api.logger, {
      structuredLogs: config.observability.structuredLogs,
    });
    const client = new A2AClient();
    const taskStore = new FileTaskStore(config.storage.tasksDir);
    const audit = new AuditLogger(config.storage.auditDir);
    const peerHealth = new PeerHealthTracker(config.peers, config.resilience, api.logger);
    const pushManager = new PushNotificationManager(
      config.pushNotifications,
      api.logger,
      (taskId, url, ok) => {
        void audit.record({
          ts: new Date().toISOString(),
          action: "push_notification",
          taskId,
          ok,
          detail: `url=${url}`,
        });
      },
    );
    const learningSyncMgr = config.learningSync.enabled
      ? new LearningSyncManager(
          {
            memoryDir: config.learningSync.memoryDir,
            instanceName: config.learningSync.instanceName,
            autoSyncIntervalSeconds: config.learningSync.autoSyncIntervalSeconds,
            excludeFiles: config.learningSync.excludeFiles,
          },
          api.logger,
        )
      : null;

    const executor = new QueueingAgentExecutor(
      new OpenClawAgentExecutor(api, config),
      telemetry,
      config.limits,
    );
    const agentCard = buildAgentCard(config);

    // Build the set of accepted bearer tokens (supports rotation)
    const acceptedTokens = new Set<string>();
    if (config.security.token) {
      acceptedTokens.add(config.security.token);
    }
    if (config.security.tokens) {
      for (const t of config.security.tokens) {
        if (t) acceptedTokens.add(t);
      }
    }

    // Validate a bearer token against all accepted tokens
    const validateBearerToken = (header: string | undefined): boolean => {
      if (!header) return false;
      const prefix = "Bearer ";
      if (!header.startsWith(prefix)) return false;
      return acceptedTokens.has(header.slice(prefix.length));
    };

    // SDK expects userBuilder(req) -> Promise<User>
    // When bearer auth is configured, validate the Authorization header.
    // Supports token rotation: accepts any token from `token` + `tokens` array.
    const userBuilder = async (req: { headers?: Record<string, string | string[] | undefined> }) => {
      if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
        const authHeader = req.headers?.authorization;
        const header = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (!validateBearerToken(header)) {
          telemetry.recordSecurityRejection("http", "invalid or missing bearer token");
          void audit.record({
            ts: new Date().toISOString(),
            action: "auth_rejected",
            method: "http",
            detail: "invalid or missing bearer token",
          });
          throw jsonRpcError(null, -32000, "Unauthorized: invalid or missing bearer token");
        }
      }
      return UserBuilder.noAuthentication();
    };

    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    const app = express();
    const createHttpMetricsMiddleware =
      (route: "jsonrpc" | "rest" | "metrics") =>
      (_req: express.Request, res: express.Response, next: express.NextFunction) => {
        const startedAt = Date.now();
        res.on("finish", () => {
          telemetry.recordInboundHttp(route, res.statusCode, Date.now() - startedAt);
        });
        next();
      };

    const cardPath = normalizeCardPath();
    const cardEndpointHandler = agentCardHandler({ agentCardProvider: requestHandler });

    app.use(cardPath, cardEndpointHandler);
    if (cardPath != "/.well-known/agent.json") {
      app.use("/.well-known/agent.json", cardEndpointHandler);
    }

    app.use(
      "/a2a/jsonrpc",
      createHttpMetricsMiddleware("jsonrpc"),
      jsonRpcHandler({
        requestHandler,
        userBuilder,
      })
    );

    // Ensure errors return JSON-RPC style responses (avoid Express HTML error pages)
    app.use("/a2a/jsonrpc", (err: unknown, _req: unknown, res: any, next: (e?: unknown) => void) => {
      if (err instanceof SyntaxError) {
        res.status(400).json(jsonRpcError(null, -32700, "Parse error"));
        return;
      }

      // Surface A2A-specific errors with proper codes
      const a2aErr = err as { code?: number; message?: string; taskId?: string } | undefined;
      if (a2aErr && typeof a2aErr.code === "number") {
        const status = a2aErr.code === -32601 ? 404 : 400;
        res.status(status).json(jsonRpcError(null, a2aErr.code, a2aErr.message || "Unknown error"));
        return;
      }

      // Generic internal error
      res.status(500).json(jsonRpcError(null, -32603, "Internal error"));
    });

    app.use(
      "/a2a/rest",
      createHttpMetricsMiddleware("rest"),
      restHandler({
        requestHandler,
        userBuilder,
      })
    );

    // Push notification endpoints (A2A spec compliant)
    if (config.pushNotifications.enabled) {
      app.post("/a2a/push/register", express.json(), async (req, res) => {
        // Auth check
        if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
          if (!validateBearerToken(req.headers.authorization)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
          }
        }
        const body = req.body || {};
        const taskId = typeof body.taskId === "string" ? body.taskId : "";
        const url = typeof body.url === "string" ? body.url : "";
        const token = typeof body.token === "string" ? body.token : undefined;
        if (!taskId || !url) {
          res.status(400).json({ error: "taskId and url are required" });
          return;
        }
        const result = pushManager.register(taskId, url, token);
        if (result.ok) {
          res.json({ registered: true });
        } else {
          res.status(400).json({ error: result.reason });
        }
      });

      app.post("/a2a/push/unregister", express.json(), async (req, res) => {
        if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
          if (!validateBearerToken(req.headers.authorization)) {
            res.status(401).json({ error: "Unauthorized" });
            return;
          }
        }
        const body = req.body || {};
        const taskId = typeof body.taskId === "string" ? body.taskId : "";
        const url = typeof body.url === "string" ? body.url : "";
        if (!taskId || !url) {
          res.status(400).json({ error: "taskId and url are required" });
          return;
        }
        const removed = pushManager.unregister(taskId, url);
        res.json({ removed });
      });
    }

    // Learning Sync HTTP endpoints
    if (config.learningSync.enabled && learningSyncMgr) {
      const lsAuthCheck = (req: express.Request, res: express.Response): boolean => {
        if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
          if (!validateBearerToken(req.headers.authorization)) {
            res.status(401).json({ error: "Unauthorized" });
            return false;
          }
        }
        return true;
      };

      app.get("/a2a/learning-sync/manifest", (req, res) => {
        if (!lsAuthCheck(req, res)) return;
        const manifest = learningSyncMgr.getManifest();
        res.json({ instanceName: config.learningSync.instanceName, mergeVersion: MERGE_VERSION, manifest });
      });

      app.post("/a2a/learning-sync/fetch", express.json(), (req, res) => {
        if (!lsAuthCheck(req, res)) return;
        const name = typeof req.body?.name === "string" ? req.body.name : "";
        if (!name) {
          res.status(400).json({ error: "name is required" });
          return;
        }
        const content = learningSyncMgr.readFile(name);
        if (content === null) {
          res.status(404).json({ error: `file not found: ${name}` });
          return;
        }
        res.json({ name, content });
      });

      app.post("/a2a/learning-sync/push", express.json({ limit: "2mb" }), (req, res) => {
        if (!lsAuthCheck(req, res)) return;
        const body = req.body || {};
        const name = typeof body.name === "string" ? body.name : "";
        const content = typeof body.content === "string" ? body.content : "";
        const remoteName = typeof body.instanceName === "string" ? body.instanceName : "remote";
        const pushMergeVersion = typeof body.mergeVersion === "number" ? body.mergeVersion : undefined;
        if (!name || !content) {
          res.status(400).json({ error: "name and content are required" });
          return;
        }
        const result = learningSyncMgr.receiveFile(name, content, remoteName, pushMergeVersion);
        void audit.record({
          ts: new Date().toISOString(),
          action: "learning_sync_receive",
          detail: `file=${name} from=${remoteName} action=${result.action} conflicts=${result.conflicts}`,
          ok: true,
        });
        res.json(result);
      });

      app.post("/a2a/learning-sync/sync", (req, res) => {
        if (!lsAuthCheck(req, res)) return;
        doLearningSync().then((results) => {
          res.json({ ok: true, results });
        }).catch((err) => {
          res.status(500).json({ ok: false, error: String(err) });
        });
      });
    }

    // Memory Query HTTP endpoint (Phase 3)
    const memoryQueryRateLimit = new Map<string, number[]>();
    if (config.memoryQuery.enabled && config.learningSync.enabled && learningSyncMgr) {
      const mqAuthCheck = (req: express.Request, res: express.Response): boolean => {
        if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
          if (!validateBearerToken(req.headers.authorization)) {
            res.status(401).json({ error: "Unauthorized" });
            return false;
          }
        }
        return true;
      };

      app.post("/a2a/memory/query", express.json(), (req, res) => {
        if (!mqAuthCheck(req, res)) return;

        // Rate limit by IP
        const clientKey = req.ip || "unknown";
        const now = Date.now();
        let timestamps = memoryQueryRateLimit.get(clientKey) || [];
        timestamps = timestamps.filter((t) => now - t < 60_000);
        if (timestamps.length >= config.memoryQuery.rateLimitPerMinute) {
          memoryQueryRateLimit.set(clientKey, timestamps);
          res.status(429).json({ error: "Rate limit exceeded" });
          return;
        }
        timestamps.push(now);
        memoryQueryRateLimit.set(clientKey, timestamps);

        const body = req.body || {};
        const query = typeof body.query === "string" ? body.query.trim() : "";
        if (!query) {
          res.status(400).json({ error: "query is required" });
          return;
        }

        const result = learningSyncMgr.search({
          query,
          date: typeof body.date === "string" ? body.date : undefined,
          filePattern: typeof body.filePattern === "string" ? body.filePattern : undefined,
          maxResults: Math.min(
            typeof body.maxResults === "number" ? body.maxResults : config.memoryQuery.maxResults,
            config.memoryQuery.maxResults,
          ),
          maxTotalChars: config.memoryQuery.maxTotalChars,
          knownHashes: Array.isArray(body.knownHashes)
            ? body.knownHashes.filter((h: unknown) => typeof h === "string")
            : undefined,
        });

        void audit.record({
          ts: new Date().toISOString(),
          action: "memory_query",
          detail: `query="${query}" matches=${result.totalFound} returned=${result.matches.length} truncated=${result.truncated}`,
          ok: true,
        });

        const response: MemoryQueryResponse = {
          instanceName: config.learningSync.instanceName,
          matches: result.matches,
          totalFound: result.totalFound,
          truncated: result.truncated,
        };

        res.json(response);
      });
    }

    // STATUS.md read endpoint — lets any peer fetch current project status
    app.get("/a2a/status", (_req, res) => {
      const statusPath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "STATUS.md",
      );
      if (fs.existsSync(statusPath)) {
        res.type("text/markdown").send(fs.readFileSync(statusPath, "utf8"));
      } else {
        res.status(404).json({ error: "STATUS.md not found" });
      }
    });

    // ------------------------------------------------------------------
    // Browse endpoint — direct browser control, bypasses agent LLM
    // POST /a2a/browse { command: "snapshot -i" }
    // ------------------------------------------------------------------
    app.post("/a2a/browse", express.json(), async (req, res) => {
      // Auth check
      if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
        const authHeader = req.headers.authorization;
        if (!validateBearerToken(authHeader)) {
          res.status(401).json({ error: "Unauthorized" });
          return;
        }
      }

      const command = (req.body?.command || "").trim();
      if (!command) {
        res.status(400).json({ error: "command is required" });
        return;
      }

      const allowed = [
        "open", "snapshot", "click", "find", "eval", "get",
        "screenshot", "status", "restart", "scroll", "wait",
        "type", "fill", "press", "hover", "back", "forward", "reload",
      ];
      const sub = command.split(/\s+/)[0];
      if (!allowed.includes(sub)) {
        res.status(400).json({ error: `Denied: "${sub}" not allowed. Allowed: ${allowed.join(", ")}` });
        return;
      }

      try {
        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          execFile("/bin/bash", ["-c", `/usr/local/bin/browse ${command}`], {
            timeout: 120_000,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, HOME: "/home/ai-agent", DISPLAY: ":1" },
          }, (err, stdout, stderr) => {
            if (err && sub !== "open") {
              reject(err);
            } else {
              resolve({ stdout: stdout || "", stderr: stderr || "" });
            }
          });
        });
        res.json({ ok: true, output: stdout.trim() || stderr.trim() });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.json({ ok: false, error: msg });
      }
    });

    api.logger.info("a2a-gateway: /a2a/browse endpoint registered");

    if (config.observability.exposeMetricsEndpoint) {
      app.get(
        config.observability.metricsPath,
        createHttpMetricsMiddleware("metrics"),
        (req, res) => {
          // Protect metrics endpoint with bearer auth when configured
          if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
            const authHeader = req.headers.authorization;
            if (!validateBearerToken(authHeader)) {
              telemetry.recordSecurityRejection("http", "metrics endpoint auth failed");
              res.status(401).json({ error: "Unauthorized" });
              return;
            }
          }
          res.json(telemetry.snapshot());
        },
      );
    }

    let server: Server | null = null;
    let grpcServer: GrpcServer | null = null;
    let cleanupTimer: ReturnType<typeof setInterval> | null = null;
    const grpcPort = config.server.port + 1;

    api.registerGatewayMethod("a2a.metrics", ({ respond }) => {
      respond(true, {
        metrics: telemetry.snapshot(),
      });
    });

    api.registerGatewayMethod("a2a.peers", ({ respond }) => {
      respond(true, {
        peers: peerHealth.snapshot(),
      });
    });

    // Push notification management
    api.registerGatewayMethod("a2a.pushNotifications.register", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      const url = asString(payload.url, "");
      const token = asString(payload.token, "") || undefined;
      if (!taskId || !url) {
        respond(false, { error: "taskId and url are required" });
        return;
      }
      const result = pushManager.register(taskId, url, token);
      respond(result.ok, result.ok ? { registered: true } : { error: result.reason });
    });

    api.registerGatewayMethod("a2a.pushNotifications.unregister", ({ params, respond }) => {
      const payload = asObject(params);
      const taskId = asString(payload.taskId, "");
      const url = asString(payload.url, "");
      if (!taskId || !url) {
        respond(false, { error: "taskId and url are required" });
        return;
      }
      const removed = pushManager.unregister(taskId, url);
      respond(true, { removed });
    });

    // ----------------------------------------------------------------
    // Learning Sync gateway methods
    // ----------------------------------------------------------------

    api.registerGatewayMethod("a2a.learningSync.manifest", ({ respond }) => {
      if (!learningSyncMgr) {
        respond(false, { error: "learningSync is not enabled" });
        return;
      }
      const manifest = learningSyncMgr.getManifest();
      respond(true, { instanceName: config.learningSync.instanceName, manifest });
    });

    api.registerGatewayMethod("a2a.learningSync.fetch", ({ params, respond }) => {
      if (!learningSyncMgr) {
        respond(false, { error: "learningSync is not enabled" });
        return;
      }
      const payload = asObject(params);
      const name = asString(payload.name, "");
      if (!name) {
        respond(false, { error: "name is required" });
        return;
      }
      const content = learningSyncMgr.readFile(name);
      if (content === null) {
        respond(false, { error: `file not found: ${name}` });
        return;
      }
      respond(true, { name, content });
    });

    api.registerGatewayMethod("a2a.learningSync.push", ({ params, respond }) => {
      if (!learningSyncMgr) {
        respond(false, { error: "learningSync is not enabled" });
        return;
      }
      const payload = asObject(params);
      const name = asString(payload.name, "");
      const content = asString(payload.content, "");
      const remoteName = asString(payload.instanceName, "remote");
      if (!name || !content) {
        respond(false, { error: "name and content are required" });
        return;
      }
      const result = learningSyncMgr.receiveFile(name, content, remoteName);
      void audit.record({
        ts: new Date().toISOString(),
        action: "learning_sync_receive",
        detail: `file=${name} from=${remoteName} action=${result.action} conflicts=${result.conflicts}`,
        ok: true,
      });
      respond(true, result);
    });

    api.registerGatewayMethod("a2a.learningSync.sync", ({ respond }) => {
      if (!learningSyncMgr) {
        respond(false, { error: "learningSync is not enabled" });
        return;
      }
      // Trigger a full sync cycle against all peers
      doLearningSync().then((results) => {
        respond(true, { results });
      }).catch((err) => {
        respond(false, { error: String(err) });
      });
    });

    // Full sync cycle: for each peer, exchange manifests and sync missing/changed files via HTTP
    async function doLearningSync(): Promise<Array<{ peer: string; fetched: number; sent: number; conflicts: number; error?: string }>> {
      if (!learningSyncMgr) return [];
      const results: Array<{ peer: string; fetched: number; sent: number; conflicts: number; error?: string }> = [];

      for (const peer of config.peers) {
        try {
          // Skip peer if circuit breaker is open
          if (!peerHealth.isAvailable(peer.name)) {
            results.push({ peer: peer.name, fetched: 0, sent: 0, conflicts: 0, error: "skipped: circuit breaker open" });
            continue;
          }

          const peerBase = new URL(peer.agentCardUrl).origin;
          const authHeaders: Record<string, string> = {};
          if (peer.auth?.token) {
            if (peer.auth.type === "bearer") {
              authHeaders["authorization"] = `Bearer ${peer.auth.token}`;
            } else {
              authHeaders["x-api-key"] = peer.auth.token;
            }
          }

          // 1. Get remote manifest
          const manifestRes = await fetch(`${peerBase}/a2a/learning-sync/manifest`, {
            headers: authHeaders,
            signal: AbortSignal.timeout(15_000),
          });
          if (!manifestRes.ok) {
            peerHealth.recordFailure(peer.name);
            results.push({ peer: peer.name, fetched: 0, sent: 0, conflicts: 0, error: `manifest HTTP ${manifestRes.status}` });
            continue;
          }
          const remoteData = await manifestRes.json() as { instanceName?: string; mergeVersion?: number; manifest?: Array<{ name: string; hash: string; size: number; mtime: number }> };
          const remoteManifest = remoteData.manifest || [];
          const remoteName = remoteData.instanceName || peer.name;
          const peerMergeVersion = remoteData.mergeVersion;

          // 2. Diff
          const diff = learningSyncMgr.diffManifest(remoteManifest);
          let fetched = 0;
          let sent = 0;
          let conflicts = 0;

          // 3. Fetch files we need from remote
          for (const fileName of diff.toFetch) {
            const fetchRes = await fetch(`${peerBase}/a2a/learning-sync/fetch`, {
              method: "POST",
              headers: { ...authHeaders, "content-type": "application/json" },
              body: JSON.stringify({ name: fileName }),
              signal: AbortSignal.timeout(15_000),
            });
            if (fetchRes.ok) {
              const fileData = await fetchRes.json() as { name: string; content: string };
              if (fileData.content) {
                const mergeResult = learningSyncMgr.receiveFile(fileName, fileData.content, remoteName, peerMergeVersion);
                if (mergeResult.action !== "unchanged") fetched++;
                conflicts += mergeResult.conflicts;
              }
            }
          }

          // 4. Push files the remote needs (use post-merge content for files that were also fetched)
          // Combine: files only on local + files that were in both (merged locally, push merged version)
          const filesToPush = new Set(diff.toSend);
          // Also re-push any file that was fetched+merged (both sides had it with different hashes)
          for (const fileName of diff.toFetch) {
            if (diff.toSend.includes(fileName)) continue; // already in set
            // If we fetched and merged, push the merged version back
            filesToPush.add(fileName);
          }
          for (const fileName of filesToPush) {
            const content = learningSyncMgr.readFile(fileName);
            if (content) {
              await fetch(`${peerBase}/a2a/learning-sync/push`, {
                method: "POST",
                headers: { ...authHeaders, "content-type": "application/json" },
                body: JSON.stringify({
                  name: fileName,
                  content,
                  instanceName: config.learningSync.instanceName,
                  mergeVersion: MERGE_VERSION,
                }),
                signal: AbortSignal.timeout(15_000),
              });
              sent++;
            }
          }


          peerHealth.recordSuccess(peer.name);
          results.push({ peer: peer.name, fetched, sent, conflicts });
          void audit.record({
            ts: new Date().toISOString(),
            action: "learning_sync_cycle",
            peer: peer.name,
            ok: true,
            detail: `fetched=${fetched} sent=${sent} conflicts=${conflicts}`,
          });
        } catch (err) {
          peerHealth.recordFailure(peer.name);
          results.push({ peer: peer.name, fetched: 0, sent: 0, conflicts: 0, error: String(err) });
        }
      }

      return results;
    }

    // ----------------------------------------------------------------
    // Delegation (Phase 2 Claw-to-Claw)
    // ----------------------------------------------------------------

    const delegationMgr = config.delegation.enabled
      ? new DelegationManager(
          config.delegation,
          config.peers,
          client,
          peerHealth,
          audit,
          api.logger,
        )
      : null;

    api.registerGatewayMethod("a2a.delegate", ({ params, respond }) => {
      if (!delegationMgr) {
        respond(false, { error: "delegation is not enabled" });
        return;
      }
      const payload = asObject(params);
      const peer = asString(payload.peer, "");
      const taskType = asString(payload.taskType, "") as any;
      const message = asString(payload.message, "");
      const waitForResult = payload.waitForResult !== undefined ? asBoolean(payload.waitForResult, true) : true;
      const timeoutMs = payload.timeoutMs !== undefined ? asNumber(payload.timeoutMs, 0) : undefined;

      if (!peer || !taskType || !message) {
        respond(false, { error: "peer, taskType, and message are required" });
        return;
      }
      if (!VALID_DELEGATION_TASK_TYPES.has(taskType)) {
        respond(false, { error: `Invalid taskType: "${taskType}". Must be one of: query, device, operation, custom` });
        return;
      }

      delegationMgr.delegate({ peer, taskType, message, waitForResult, timeoutMs: timeoutMs || undefined })
        .then((result) => {
          const ok = result.status === "completed" || result.status === "pending" || result.status === "working";
          respond(ok, result);
        })
        .catch((err) => {
          respond(false, { error: String(err?.message || err) });
        });
    });

    api.registerGatewayMethod("a2a.delegate.status", ({ params, respond }) => {
      if (!delegationMgr) {
        respond(false, { error: "delegation is not enabled" });
        return;
      }
      const payload = asObject(params);
      const delegationId = asString(payload.delegationId, "");
      if (!delegationId) {
        respond(false, { error: "delegationId is required" });
        return;
      }
      const status = delegationMgr.getStatus(delegationId);
      if (!status) {
        respond(false, { error: `Delegation not found: ${delegationId}` });
        return;
      }
      respond(true, status);
    });

    api.registerGatewayMethod("a2a.delegate.list", ({ respond }) => {
      if (!delegationMgr) {
        respond(false, { error: "delegation is not enabled" });
        return;
      }
      respond(true, { delegations: delegationMgr.listAll() });
    });

    // ------------------------------------------------------------------
    // Memory Query gateway methods (Phase 3)
    // ------------------------------------------------------------------

    api.registerGatewayMethod("a2a.memory.search", ({ params, respond }) => {
      if (!learningSyncMgr) {
        respond(false, { error: "learningSync is not enabled" });
        return;
      }
      const payload = asObject(params);
      const query = asString(payload.query, "").trim();
      if (!query) {
        respond(false, { error: "query is required" });
        return;
      }

      const result = learningSyncMgr.search({
        query,
        date: asString(payload.date, "") || undefined,
        filePattern: asString(payload.filePattern, "") || undefined,
        maxResults: payload.maxResults ? asNumber(payload.maxResults, 10) : undefined,
        maxTotalChars: config.memoryQuery.maxTotalChars,
      });

      respond(true, {
        instanceName: config.learningSync.instanceName,
        ...result,
      });
    });

    api.registerGatewayMethod("a2a.memory.query", ({ params, respond }) => {
      if (!learningSyncMgr) {
        respond(false, { error: "learningSync is not enabled" });
        return;
      }
      const payload = asObject(params);
      const peerName = asString(payload.peer, "");
      const query = asString(payload.query, "").trim();
      if (!peerName || !query) {
        respond(false, { error: "peer and query are required" });
        return;
      }

      const peer = config.peers.find((p) => p.name === peerName);
      if (!peer) {
        respond(false, { error: `Peer not found: ${peerName}` });
        return;
      }

      if (!peerHealth.isAvailable(peerName)) {
        respond(false, { error: `Peer "${peerName}" is unavailable (circuit breaker open)` });
        return;
      }

      const request: MemoryQueryRequest = {
        query,
        date: asString(payload.date, "") || undefined,
        filePattern: asString(payload.filePattern, "") || undefined,
        maxResults: payload.maxResults ? asNumber(payload.maxResults, 10) : undefined,
      };

      if (config.memoryQuery.deduplicateSyncedWithinSeconds > 0) {
        const manifest = learningSyncMgr.getManifest();
        request.knownHashes = manifest.map((e) => e.hash);
      }

      client.queryMemory(peer, request)
        .then((result) => {
          if (result.ok && result.response) {
            void audit.record({
              ts: new Date().toISOString(),
              action: "memory_query_remote",
              peer: peerName,
              detail: `query="${query}" matches=${result.response.totalFound} returned=${result.response.matches.length}`,
              ok: true,
            });
            peerHealth.recordSuccess(peerName);
            respond(true, result.response);
          } else {
            peerHealth.recordFailure(peerName);
            respond(false, { error: result.error || "Query failed" });
          }
        })
        .catch((err) => {
          peerHealth.recordFailure(peerName);
          respond(false, { error: String(err) });
        });
    });

    api.registerGatewayMethod("a2a.send", ({ params, respond }) => {
      const payload = asObject(params);
      const peerName = asString(payload.peer || payload.name, "");
      const message = asObject(payload.message || payload.payload);

      const peer = config.peers.find((candidate) => candidate.name === peerName);
      if (!peer) {
        respond(false, { error: `Peer not found: ${peerName}` });
        return;
      }

      // Circuit breaker check
      if (!peerHealth.isAvailable(peer.name)) {
        void audit.record({
          ts: new Date().toISOString(),
          action: "outbound",
          peer: peer.name,
          method: "a2a.send",
          ok: false,
          detail: "circuit breaker open",
        });
        respond(false, { error: `Peer "${peer.name}" is unavailable (circuit breaker open)` });
        return;
      }

      const startedAt = Date.now();
      withRetry(() => client.sendMessage(peer, message).then((result) => {
        if (!result.ok) {
          throw Object.assign(new Error(`Peer returned ${result.statusCode}`), { result });
        }
        return result;
      }), config.resilience.maxRetries)
        .then((result) => {
          const durationMs = Date.now() - startedAt;
          peerHealth.recordSuccess(peer.name);
          telemetry.recordOutboundRequest(peer.name, true, result.statusCode, durationMs);
          void audit.record({
            ts: new Date().toISOString(),
            action: "outbound",
            peer: peer.name,
            method: "a2a.send",
            ok: true,
            statusCode: result.statusCode,
            durationMs,
          });
          respond(true, {
            statusCode: result.statusCode,
            response: result.response,
          });
        })
        .catch((error) => {
          const durationMs = Date.now() - startedAt;
          peerHealth.recordFailure(peer.name);

          // Extract status from enriched error if available
          const enrichedResult = (error as any)?.result;
          const statusCode = enrichedResult?.statusCode || 500;
          const response = enrichedResult?.response;

          telemetry.recordOutboundRequest(peer.name, false, statusCode, durationMs);
          void audit.record({
            ts: new Date().toISOString(),
            action: "outbound",
            peer: peer.name,
            method: "a2a.send",
            ok: false,
            statusCode,
            durationMs,
            detail: String(error?.message || error),
          });

          if (response) {
            respond(false, { statusCode, response });
          } else {
            respond(false, { error: String(error?.message || error) });
          }
        });
    });

    // ------------------------------------------------------------------
    // Agent tool: a2a_send_file
    // Lets the agent send a file (by URI) to a peer via A2A FilePart.
    // ------------------------------------------------------------------
    if (api.registerTool) {
      const sendFileParams = {
        type: "object" as const,
        required: ["peer", "uri"],
        properties: {
          peer: { type: "string" as const, description: "Name of the target peer (must match a configured peer name)" },
          uri: { type: "string" as const, description: "Public URL of the file to send" },
          name: { type: "string" as const, description: "Filename (e.g. report.pdf)" },
          mimeType: { type: "string" as const, description: "MIME type (e.g. application/pdf). Auto-detected from extension if omitted." },
          text: { type: "string" as const, description: "Optional text message to include alongside the file" },
          agentId: { type: "string" as const, description: "Route to a specific agentId on the peer (OpenClaw extension). Omit to use the peer's default agent." },
        },
      };

      api.registerTool({
        name: "a2a_send_file",
        description: "Send a file to a peer agent via A2A. The file is referenced by its public URL (URI). " +
          "Use this when you need to transfer a document, image, or any file to another agent.",
        label: "A2A Send File",
        parameters: sendFileParams,
        async execute(toolCallId, params) {
          const peer = config.peers.find((p) => p.name === params.peer);
          if (!peer) {
            const available = config.peers.map((p) => p.name).join(", ") || "(none)";
            return {
              content: [{ type: "text" as const, text: `Peer not found: "${params.peer}". Available peers: ${available}` }],
              details: { ok: false },
            };
          }

          // Security checks: SSRF, MIME, file size
          const uriCheck = await validateUri(params.uri, config.security);
          if (!uriCheck.ok) {
            return {
              content: [{ type: "text" as const, text: `URI rejected: ${uriCheck.reason}` }],
              details: { ok: false, reason: uriCheck.reason },
            };
          }

          if (params.mimeType && !validateMimeType(params.mimeType, config.security.allowedMimeTypes)) {
            return {
              content: [{ type: "text" as const, text: `MIME type rejected: "${params.mimeType}" is not in the allowed list` }],
              details: { ok: false },
            };
          }

          const parts: Array<Record<string, unknown>> = [];
          if (params.text) {
            parts.push({ kind: "text", text: params.text });
          }
          parts.push({
            kind: "file",
            file: {
              uri: params.uri,
              ...(params.name ? { name: params.name } : {}),
              ...(params.mimeType ? { mimeType: params.mimeType } : {}),
            },
          });

          try {
            const message: Record<string, unknown> = { parts };
            if (params.agentId) {
              message.agentId = params.agentId;
            }
            const result = await client.sendMessage(peer, message);
            void audit.record({
              ts: new Date().toISOString(),
              action: "file_send",
              peer: params.peer,
              ok: result.ok,
              statusCode: result.statusCode,
              detail: `uri=${params.uri}`,
            });
            if (result.ok) {
              return {
                content: [{ type: "text" as const, text: `File sent to ${params.peer} via A2A.\nURI: ${params.uri}\nResponse: ${JSON.stringify(result.response)}` }],
                details: { ok: true, response: result.response },
              };
            }
            return {
              content: [{ type: "text" as const, text: `Failed to send file to ${params.peer}: ${JSON.stringify(result.response)}` }],
              details: { ok: false, response: result.response },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            void audit.record({
              ts: new Date().toISOString(),
              action: "file_send",
              peer: params.peer,
              ok: false,
              detail: `uri=${params.uri} error=${msg}`,
            });
            return {
              content: [{ type: "text" as const, text: `Error sending file to ${params.peer}: ${msg}` }],
              details: { ok: false, error: msg },
            };
          }
        },
      });
    }

    // ------------------------------------------------------------------
    // Agent tool: a2a_delegate
    // Lets the agent delegate tasks to a peer and get structured results.
    // ------------------------------------------------------------------
    if (api.registerTool && delegationMgr) {
      const delegateParams = {
        type: "object" as const,
        required: ["peer", "taskType", "message"],
        properties: {
          peer: { type: "string" as const, description: "Name of the target peer (must match a configured peer name)" },
          taskType: { type: "string" as const, enum: ["query", "device", "operation", "custom"], description: "Type of task to delegate" },
          message: { type: "string" as const, description: "The task instruction / message to send to the peer" },
          waitForResult: { type: "boolean" as const, description: "Wait for the task to complete before returning (default true)" },
          timeoutMs: { type: "number" as const, description: "Max milliseconds to wait for result (default from config, typically 120000)" },
        },
      };

      api.registerTool({
        name: "a2a_delegate",
        description: "Delegate a task to a peer agent via A2A. The peer will execute the task and return a structured result. " +
          "Use this when you need another agent (e.g. on a phone or different machine) to perform an action on your behalf.",
        label: "A2A Delegate Task",
        parameters: delegateParams,
        async execute(_toolCallId, params) {
          const result = await delegationMgr!.delegate({
            peer: params.peer,
            taskType: params.taskType as DelegationTaskType,
            message: params.message,
            waitForResult: params.waitForResult !== undefined ? params.waitForResult : true,
            timeoutMs: params.timeoutMs || undefined,
          });

          const ok = result.status === "completed";
          const summary = ok
            ? `Delegation to ${result.peer} completed.\n${result.result?.text || "(no text result)"}`
            : `Delegation to ${result.peer} ${result.status}: ${result.error || "(no details)"}`;

          return {
            content: [{ type: "text" as const, text: summary }],
            details: { ok, ...result },
          };
        },
      });
    }

    // ------------------------------------------------------------------
    // Agent tool: a2a_memory_query
    // Lets the agent search a peer's memory for relevant information.
    // ------------------------------------------------------------------
    if (api.registerTool && learningSyncMgr && config.memoryQuery.enabled) {
      const memoryQueryParams = {
        type: "object" as const,
        required: ["peer", "query"],
        properties: {
          peer: { type: "string" as const, description: "Name of the target peer to query memory from" },
          query: { type: "string" as const, description: "Search query (keywords, date references, topic names)" },
          date: { type: "string" as const, description: "Optional: filter by date (YYYY-MM-DD format)" },
          filePattern: { type: "string" as const, description: "Optional: filter by file pattern (e.g. '2026-03-*')" },
          maxResults: { type: "number" as const, description: "Max results to return (default 10)" },
        },
      };

      api.registerTool({
        name: "a2a_memory_query",
        description: "Search a peer agent's memory for relevant information. " +
          "Use this when you need to find what the other agent has learned or remembered about a topic. " +
          "For simple keyword searches. For complex reasoning queries, use a2a_delegate instead.",
        label: "A2A Memory Query",
        parameters: memoryQueryParams,
        async execute(_toolCallId, params) {
          const peer = config.peers.find((p) => p.name === params.peer);
          if (!peer) {
            const available = config.peers.map((p) => p.name).join(", ") || "(none)";
            return {
              content: [{ type: "text" as const, text: `Peer not found: "${params.peer}". Available peers: ${available}` }],
              details: { ok: false },
            };
          }

          const request: MemoryQueryRequest = {
            query: params.query,
            date: params.date || undefined,
            filePattern: params.filePattern || undefined,
            maxResults: params.maxResults || undefined,
          };

          const result = await client.queryMemory(peer, request);

          if (!result.ok || !result.response) {
            return {
              content: [{ type: "text" as const, text: `Memory query failed: ${result.error}` }],
              details: { ok: false, error: result.error },
            };
          }

          const resp = result.response;
          if (resp.matches.length === 0) {
            return {
              content: [{ type: "text" as const, text: `No memory matches found on ${params.peer} for query: "${params.query}"` }],
              details: { ok: true, totalFound: 0 },
            };
          }

          const formatted = resp.matches.map((m, i) =>
            `### Match ${i + 1} (score: ${m.score.toFixed(2)}) — ${m.fileName}\n${m.sectionHeader}\n${m.snippet}`
          ).join("\n\n---\n\n");

          const summary = `Found ${resp.totalFound} matches on ${resp.instanceName}, showing ${resp.matches.length}${resp.truncated ? " (truncated)" : ""}:\n\n${formatted}`;

          return {
            content: [{ type: "text" as const, text: summary }],
            details: { ok: true, ...resp },
          };
        },
      });
    }

    // ------------------------------------------------------------------
    // Agent tool: browse
    // Lets the agent control a headless Chrome browser via agent-browser.
    // Chrome runs as a systemd service (chrome-cdp) with CDP on port 9222.
    // ------------------------------------------------------------------
    if (api.registerTool) {
      const browseParams = {
        type: "object" as const,
        required: ["command"],
        properties: {
          command: {
            type: "string" as const,
            description: [
              "The browse command to execute. Examples:",
              '  open https://example.com  — Navigate to URL',
              '  snapshot                  — Get page text content (accessibility tree)',
              '  snapshot -i               — Get only interactive elements with @ref IDs',
              '  click @e5                 — Click element by ref',
              '  find text "Success Plan" click — Find text and click it',
              '  eval "document.title"     — Run JavaScript',
              '  get url                   — Get current page URL',
              '  screenshot                — Take screenshot',
              '  status                    — Check Chrome CDP status',
              '  restart                   — Restart Chrome + daemon',
            ].join("\n"),
          },
        },
      };

      api.registerTool({
        name: "browse",
        description:
          "Control a headless Chrome browser on this VM. " +
          "Use this to navigate websites, take snapshots, click elements, and interact with web pages. " +
          "The browser has persistent login sessions (cookies preserved across restarts). " +
          "Workflow: open URL → snapshot -i (get interactive elements) → click @ref → snapshot again.",
        label: "Browse Web",
        parameters: browseParams,
        async execute(_toolCallId, params) {
          const command = (params.command || "").trim();
          if (!command) {
            return {
              content: [{ type: "text" as const, text: "Error: command is required" }],
              details: { ok: false },
            };
          }

          // Allowlisted subcommands to prevent arbitrary shell execution
          const allowed = [
            "open", "snapshot", "click", "find", "eval", "get",
            "screenshot", "status", "restart", "scroll", "wait",
            "type", "fill", "press", "hover", "back", "forward", "reload",
          ];
          const sub = command.split(/\s+/)[0];
          if (!allowed.includes(sub)) {
            return {
              content: [{ type: "text" as const, text: `Denied: "${sub}" is not an allowed browse subcommand. Allowed: ${allowed.join(", ")}` }],
              details: { ok: false },
            };
          }

          return new Promise((resolve) => {
            // Use shell to handle the browse wrapper correctly
            execFile("/bin/bash", ["-c", `/usr/local/bin/browse ${command}`], {
              timeout: 120_000,
              maxBuffer: 1024 * 1024,
              env: { ...process.env, HOME: "/home/ai-agent", DISPLAY: ":1" },
            }, (err, stdout, stderr) => {
              const output = (stdout || "").trim();
              const errMsg = (stderr || "").trim();
              const text = output || errMsg || (err ? err.message : "(no output)");

              // open command may timeout due to SPA iframes — that's OK
              const isOpenTimeout = sub === "open" && err?.message?.includes("timeout");
              const ok = !err || isOpenTimeout;

              resolve({
                content: [{ type: "text" as const, text }],
                details: { ok, subcommand: sub },
              });
            });
          });
        },
      });

      api.logger.info("a2a-gateway: browse tool registered");
    }

    // ------------------------------------------------------------------
    // Hook: Inject delegation-aware system prompt for A2A inbound tasks
    //
    // When an inbound A2A message lands on a delegation session (detected
    // via sessionKey pattern + delegation prefix in the prompt), override
    // the system prompt so the agent treats it as an isolated, fresh task
    // instead of resuming a prior conversation.
    // ------------------------------------------------------------------
    if (config.delegation.enabled && api.on) {
      const DELEGATION_PREFIX_RE = /\[Delegated Task\s*\|/;
      const A2A_SESSION_RE = /:a2a:/;

      api.on("before_prompt_build", (event, ctx) => {
        const sessionKey = ctx.sessionKey || "";
        const prompt = event.prompt || "";

        // Only activate for A2A sessions carrying a delegation marker
        if (!A2A_SESSION_RE.test(sessionKey) || !DELEGATION_PREFIX_RE.test(prompt)) {
          return;
        }

        return {
          systemPrompt: [
            "You are an OpenClaw agent executing a delegated task from a peer agent.",
            "This is a NEW, INDEPENDENT task — you have NO prior conversation context.",
            "Instructions:",
            "- Read the task description carefully and execute it directly.",
            "- For ANY web browsing task, you MUST use the `browse` tool (NOT the built-in `browser` tool). The `browse` tool connects to a persistent Chrome with saved login sessions. The built-in `browser` tool requires Browser Relay and will NOT work.",
            "- Use other available tools (calendar, web search, file access, etc.) as needed.",
            "- Reply in the SAME LANGUAGE as the task message.",
            "- Be concise and action-oriented. Return the result, not meta-commentary.",
            "- When using the `browse` tool, return the RAW snapshot output directly to the caller. Do NOT summarize, interpret, or add your own analysis. The caller needs the original page content to do their own analysis.",
            "- Do NOT reference previous conversations, sessions, or attempts.",
            "- If you cannot complete the task, explain why clearly.",
            "",
            "## Available Tools on This Agent",
            "",
            "### browse(command: string)",
            "Control a headless Chrome browser with persistent login sessions.",
            "The browser has saved cookies for mastermind.com and mindfulnessexercises.com.",
            "Usage: call the `browse` tool with a command string. Examples:",
            "  browse open https://example.com  — Navigate to URL",
            "  browse snapshot -i               — Get interactive elements with @ref IDs",
            "  browse snapshot                  — Get full page text content",
            "  browse click @e5                 — Click element by ref",
            "  browse eval \"JS code\"            — Run JavaScript in page",
            "  browse get url                   — Get current page URL",
            "",
            "IMPORTANT for Mastermind.com (SPA):",
            "  1. browse open https://app.mastermind.com/account/home",
            "  2. browse eval \"document.querySelector('a[href*=\\\"business_plan\\\"]').click()\"",
            "  3. Wait 3 seconds, then browse snapshot -i",
            "  Do NOT open success_plan URL directly — use site navigation.",
            "",
            "### a2a_send_file(peer, uri, ...)",
            "Send a file to a peer agent via A2A.",
            "",
            "### a2a_delegate(peer, taskType, message)",
            "Delegate a task to a peer agent.",
            "",
            "### a2a_memory_query(peer, query, ...)",
            "Search a peer agent's memory.",
          ].join("\n"),
        };
      });

      api.logger.info("a2a-gateway: delegation prompt hook registered");
    }

    if (!api.registerService) {
      api.logger.warn("a2a-gateway: registerService is unavailable; HTTP endpoints are not started");
      return;
    }

    api.registerService({
      id: "a2a-gateway",
      async start(_ctx) {
        if (server) {
          return;
        }

        // Start HTTP server (JSON-RPC + REST)
        await new Promise<void>((resolve, reject) => {
          server = app.listen(config.server.port, config.server.host, () => {
            api.logger.info(
              `a2a-gateway: HTTP listening on ${config.server.host}:${config.server.port}`
            );
            api.logger.info(
              `a2a-gateway: durable task store at ${config.storage.tasksDir}; concurrency=${config.limits.maxConcurrentTasks}; queue=${config.limits.maxQueuedTasks}`
            );
            resolve();
          });

          server!.once("error", reject);
        });

        // Start gRPC server
        try {
          grpcServer = new GrpcServer();
          const grpcUserBuilder = async (
            call: { metadata?: { get: (key: string) => unknown[] } } | unknown,
          ) => {
            if (config.security.inboundAuth === "bearer" && acceptedTokens.size > 0) {
              const meta = (call as any)?.metadata;
              const values = meta?.get?.("authorization") || meta?.get?.("Authorization") || [];
              const header = Array.isArray(values) && values.length > 0 ? String(values[0]) : "";
              if (!validateBearerToken(header)) {
                telemetry.recordSecurityRejection("grpc", "invalid or missing bearer token");
                void audit.record({
                  ts: new Date().toISOString(),
                  action: "auth_rejected",
                  method: "grpc",
                  detail: "invalid or missing bearer token",
                });
                const err: any = new Error("Unauthorized: invalid or missing bearer token");
                err.code = GrpcStatus.UNAUTHENTICATED;
                throw err;
              }
            }
            return GrpcUserBuilder.noAuthentication();
          };

          grpcServer.addService(
            A2AService,
            grpcService({ requestHandler, userBuilder: grpcUserBuilder as any })
          );

          await new Promise<void>((resolve, reject) => {
            grpcServer!.bindAsync(
              `${config.server.host}:${grpcPort}`,
              ServerCredentials.createInsecure(),
              (error) => {
                if (error) {
                  api.logger.warn(`a2a-gateway: gRPC failed to start: ${error.message}`);
                  grpcServer = null;
                  resolve(); // Non-fatal: HTTP still works
                  return;
                }
                try {
                  grpcServer!.start();
                } catch {
                  // ignore: some grpc-js versions auto-start
                }
                api.logger.info(
                  `a2a-gateway: gRPC listening on ${config.server.host}:${grpcPort}`
                );
                resolve();
              }
            );
          });
        } catch (grpcError: unknown) {
          const msg = grpcError instanceof Error ? grpcError.message : String(grpcError);
          api.logger.warn(`a2a-gateway: gRPC init failed: ${msg}`);
          grpcServer = null;
        }

        // Start task TTL cleanup
        const ttlMs = config.storage.taskTtlHours * 3_600_000;
        const intervalMs = config.storage.cleanupIntervalMinutes * 60_000;

        const doCleanup = () => {
          void runTaskCleanup(taskStore, ttlMs, telemetry, api.logger);
        };

        // Run once at startup to clear any backlog
        doCleanup();
        cleanupTimer = setInterval(doCleanup, intervalMs);

        api.logger.info(
          `a2a-gateway: task cleanup enabled — ttl=${config.storage.taskTtlHours}h interval=${config.storage.cleanupIntervalMinutes}min`,
        );

        // Start peer health checks
        if (config.peers.length > 0) {
          peerHealth.start();
          api.logger.info(
            `a2a-gateway: peer health checks enabled — interval=${config.resilience.healthCheckIntervalSeconds}s threshold=${config.resilience.circuitBreakerThreshold} cooldown=${config.resilience.circuitBreakerCooldownSeconds}s`,
          );
        }

        // Start learning sync auto-sync
        if (learningSyncMgr && config.learningSync.autoSyncIntervalSeconds > 0 && config.peers.length > 0) {
          learningSyncMgr.startAutoSync(async () => {
            const results = await doLearningSync();
            for (const r of results) {
              if (r.error) {
                api.logger.warn(`a2a-gateway: learning sync with ${r.peer} failed: ${r.error}`);
              } else if (r.fetched > 0 || r.sent > 0) {
                api.logger.info(`a2a-gateway: learning sync with ${r.peer}: fetched=${r.fetched} sent=${r.sent} conflicts=${r.conflicts}`);
              }
            }
          });
          api.logger.info(
            `a2a-gateway: learning sync enabled — dir=${config.learningSync.memoryDir} interval=${config.learningSync.autoSyncIntervalSeconds}s instance=${config.learningSync.instanceName}`,
          );
        }
      },
      async stop(_ctx) {
        // Stop learning sync
        if (learningSyncMgr) {
          learningSyncMgr.stopAutoSync();
        }

        // Stop peer health checks
        peerHealth.stop();

        // Stop task cleanup timer
        if (cleanupTimer) {
          clearInterval(cleanupTimer);
          cleanupTimer = null;
        }

        // Stop gRPC server
        if (grpcServer) {
          grpcServer.forceShutdown();
          grpcServer = null;
        }

        // Stop HTTP server
        if (!server) {
          return;
        }

        await new Promise<void>((resolve, reject) => {
          const activeServer = server!;
          server = null;
          activeServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  },
};

export default plugin;
