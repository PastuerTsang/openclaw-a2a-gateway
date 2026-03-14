/**
 * A2A Gateway plugin endpoints:
 * - /.well-known/agent.json  (Agent Card discovery)
 * - /a2a/jsonrpc              (JSON-RPC transport)
 * - /a2a/rest                 (REST transport)
 * - gRPC on port+1            (gRPC transport)
 */

import type { Server } from "node:http";
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
  GatewayConfig,
  InboundAuth,
  OpenClawPluginApi,
  PeerConfig,
  RoutingRuleConfig,
} from "./src/types.js";
import {
  validateUri,
  validateMimeType,
} from "./src/file-security.js";
import { AuditLogger } from "./src/audit.js";
import { PeerHealthTracker, withRetry } from "./src/peer-health.js";
import { PushNotificationManager } from "./src/push-notifications.js";

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
      },
      async stop(_ctx) {
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
