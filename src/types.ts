/**
 * A2A Gateway Plugin — Standard types
 *
 * These types support the A2A v0.3.0 protocol integration via @a2a-js/sdk.
 */

// ---------------------------------------------------------------------------
// OpenClaw plugin API types
// ---------------------------------------------------------------------------

// Use the official OpenClaw plugin SDK types.
// IMPORTANT: keep these as type-only exports so the plugin has no runtime
// dependency on OpenClaw as an npm package.
export type { OpenClawPluginApi, PluginLogger, OpenClawConfig } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// A2A peer / auth configuration
// ---------------------------------------------------------------------------

export type InboundAuth = "none" | "bearer";
export type PeerAuthType = "bearer" | "apiKey";

export interface PeerAuthConfig {
  type: PeerAuthType;
  token: string;
}

export interface PeerConfig {
  name: string;
  agentCardUrl: string;
  auth?: PeerAuthConfig;
}

// ---------------------------------------------------------------------------
// Agent card configuration (user-provided config, NOT the A2A AgentCard)
// ---------------------------------------------------------------------------

export interface AgentSkillConfig {
  id?: string;
  name: string;
  description?: string;
}

export interface AgentCardConfig {
  name: string;
  description?: string;
  url?: string;
  skills: Array<AgentSkillConfig | string>;
}

// ---------------------------------------------------------------------------
// Gateway configuration
// ---------------------------------------------------------------------------

export interface FileSecurityConfig {
  /** Allowed MIME type patterns (e.g. "image/*", "application/pdf"). */
  allowedMimeTypes: string[];
  /** Max file size in bytes for URI-based files (default 50MB). */
  maxFileSizeBytes: number;
  /** Max file size in bytes for inline base64 files (default 10MB). */
  maxInlineFileSizeBytes: number;
  /** URI hostname allowlist patterns (e.g. "*.example.com"). Empty = allow all public hosts. */
  fileUriAllowlist: string[];
}

export interface SecurityConfig extends FileSecurityConfig {
  inboundAuth: InboundAuth;
  token?: string;
  /** Additional tokens accepted during rotation windows. */
  tokens?: string[];
}

// ---------------------------------------------------------------------------
// Routing rule configuration
// ---------------------------------------------------------------------------

export interface RoutingRuleConfig {
  /** Route key to match against inbound message metadata. */
  routeKey: string;
  /** Target agentId to dispatch to. */
  agentId: string;
  /** Optional peer name — when set, the message is forwarded to this peer instead of local dispatch. */
  peer?: string;
}

// ---------------------------------------------------------------------------
// Peer health / resilience configuration
// ---------------------------------------------------------------------------

export interface PeerResilienceConfig {
  /** Interval between health checks in seconds (default 60). */
  healthCheckIntervalSeconds: number;
  /** Number of consecutive failures before circuit opens (default 5). */
  circuitBreakerThreshold: number;
  /** Seconds to wait in open state before half-open probe (default 30). */
  circuitBreakerCooldownSeconds: number;
  /** Max retry attempts for failed sends (default 3). */
  maxRetries: number;
}

// ---------------------------------------------------------------------------
// Push notification configuration
// ---------------------------------------------------------------------------

export interface PushNotificationConfig {
  /** Enable push notification support (default false). */
  enabled: boolean;
  /** Max callbacks stored per task (default 5). */
  maxCallbacksPerTask: number;
  /** Max retry attempts for webhook delivery (default 3). */
  maxDeliveryRetries: number;
}

// ---------------------------------------------------------------------------
// Learning sync configuration
// ---------------------------------------------------------------------------

export interface LearningSyncGatewayConfig {
  /** Enable learning sync (default false). */
  enabled: boolean;
  /** Path to workspace memory directory (default auto-detected from OPENCLAW_HOME). */
  memoryDir: string;
  /** Instance name used as source tag when merging (default hostname). */
  instanceName: string;
  /** Auto-sync interval in seconds (0 = disabled, default 300 = 5 min). */
  autoSyncIntervalSeconds: number;
  /** Exact filenames to exclude from learning sync. */
  excludeFiles: string[];
}

// ---------------------------------------------------------------------------
// Delegation configuration (Phase 2 Claw-to-Claw)
// ---------------------------------------------------------------------------

export type DelegationTaskType = "query" | "device" | "operation" | "custom";

export interface DelegationPolicyRule {
  peer: string;
  allowedTaskTypes: DelegationTaskType[];
  maxConcurrent?: number;
}

export interface DelegationConfig {
  /** Enable task delegation (default false). */
  enabled: boolean;
  /** Policy rules controlling which peers can receive which task types. */
  policy: DelegationPolicyRule[];
  /** Default timeout for waiting on delegation results (default 120000ms). */
  defaultTimeoutMs: number;
  /** Interval between polling attempts (default 2000ms). */
  pollIntervalMs: number;
  /** Max number of poll attempts before timeout (default 60). */
  maxPollAttempts: number;
}

export interface DelegationResult {
  delegationId: string;
  remoteTaskId: string;
  peer: string;
  taskType: DelegationTaskType;
  status: "pending" | "working" | "completed" | "failed" | "timeout";
  result?: { text?: string; data?: unknown; artifacts?: unknown[] };
  error?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Memory query configuration (Phase 3 Claw-to-Claw)
// ---------------------------------------------------------------------------

export interface MemoryQueryConfig {
  /** Enable memory query endpoint (default: auto-enabled when learningSync is enabled). */
  enabled: boolean;
  /** Max results returned per query (default 10). */
  maxResults: number;
  /** Max total characters across all returned snippets (default 8000, ~2000 tokens). */
  maxTotalChars: number;
  /** Rate limit: max queries per minute per peer (default 10). */
  rateLimitPerMinute: number;
  /** Exclude content that has been synced within this many seconds (0 = no dedup, default 0). */
  deduplicateSyncedWithinSeconds: number;
}

export interface MemoryQueryRequest {
  /** Free-text search query (matched against section headers and body). */
  query: string;
  /** Optional: restrict search to a specific date (YYYY-MM-DD). */
  date?: string;
  /** Optional: restrict search to files matching this glob pattern (e.g. "2026-03-*"). */
  filePattern?: string;
  /** Optional: max results to return (capped by server's maxResults). */
  maxResults?: number;
  /** Optional: exclude content already present in these file hashes (for dedup). */
  knownHashes?: string[];
}

export interface MemoryQueryMatch {
  /** Source file name (e.g. "2026-03-16.md"). */
  fileName: string;
  /** Section header (e.g. "## 2026-03-16 14:30 UTC"). */
  sectionHeader: string;
  /** Matched content snippet (trimmed). */
  snippet: string;
  /** Relevance score (0-1, higher = more relevant). */
  score: number;
}

export interface MemoryQueryResponse {
  /** Instance name of the responding node. */
  instanceName: string;
  /** Matches found. */
  matches: MemoryQueryMatch[];
  /** Total matches found before truncation. */
  totalFound: number;
  /** Whether results were truncated due to limits. */
  truncated: boolean;
}

export interface GatewayConfig {
  agentCard: AgentCardConfig;
  server: {
    host: string;
    port: number;
  };
  storage: {
    tasksDir: string;
    taskTtlHours: number;
    cleanupIntervalMinutes: number;
    /** Directory for audit log files (default "data/audit"). */
    auditDir: string;
  };
  peers: PeerConfig[];
  security: SecurityConfig;
  routing: {
    defaultAgentId: string;
    /** Routing rules for message-type/tag-based routing. */
    rules: RoutingRuleConfig[];
  };
  limits: {
    maxConcurrentTasks: number;
    maxQueuedTasks: number;
  };
  observability: {
    structuredLogs: boolean;
    exposeMetricsEndpoint: boolean;
    metricsPath: string;
  };
  timeouts?: {
    /**
     * Max time to wait for the underlying OpenClaw agent run to finish (Gateway RPC `agent`).
     * Long-running prompts should use async task mode (blocking=false) + tasks/get polling.
     */
    agentResponseTimeoutMs?: number;
  };
  resilience: PeerResilienceConfig;
  pushNotifications: PushNotificationConfig;
  learningSync: LearningSyncGatewayConfig;
  delegation: DelegationConfig;
  memoryQuery: MemoryQueryConfig;
}

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export interface OutboundSendResult {
  ok: boolean;
  statusCode: number;
  response: unknown;
}
