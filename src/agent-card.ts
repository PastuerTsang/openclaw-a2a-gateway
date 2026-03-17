import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

import type { GatewayConfig } from "./types.js";

function toSkill(entry: string | { id?: string; name: string; description?: string }, index: number): AgentSkill {
  if (typeof entry === "string") {
    return {
      id: `skill-${index + 1}`,
      name: entry,
      description: entry,
      tags: [],
    };
  }

  return {
    id: entry.id || `skill-${index + 1}`,
    name: entry.name,
    description: entry.description || entry.name,
    tags: [],
  };
}

export function buildAgentCard(config: GatewayConfig): AgentCard {
  const agentCard = config.agentCard || ({} as GatewayConfig["agentCard"]);
  const server = config.server || { host: "0.0.0.0", port: 18800 };
  const configuredUrl = agentCard.url;
  const fallbackHost = server.host === "0.0.0.0" ? "localhost" : server.host;
  const fallbackUrl = `http://${fallbackHost}:${server.port}/a2a/jsonrpc`;

  const securitySchemes: AgentCard["securitySchemes"] = {};
  const security: AgentCard["security"] = [];

  const security_ = config.security || { inboundAuth: "none", token: "" };
  if (security_.inboundAuth === "bearer") {
    securitySchemes["bearer"] = {
      type: "http",
      scheme: "bearer",
    };
    security.push({ bearer: [] });
  }

  const grpcPort = server.port + 1;
  const grpcHost = server.host === "0.0.0.0"
    ? (configuredUrl ? new URL(configuredUrl).hostname : "localhost")
    : server.host;

  const card: AgentCard = {
    protocolVersion: "0.3.0",
    version: "1.0.0",
    name: agentCard.name || "OpenClaw A2A Gateway",
    description: agentCard.description || "A2A bridge for OpenClaw agents",
    url: configuredUrl || fallbackUrl,
    skills: (agentCard.skills || []).map((entry, index) => toSkill(entry, index)),
    capabilities: {
      streaming: true,
      pushNotifications: config.pushNotifications?.enabled || false,
      stateTransitionHistory: false,
    },
    securitySchemes,
    security,
    supportsAuthenticatedExtendedCard: false,
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    additionalInterfaces: [
      { url: configuredUrl || fallbackUrl, transport: "JSONRPC" },
      { url: `${new URL(configuredUrl || fallbackUrl).origin}/a2a/rest`, transport: "HTTP+JSON" },
      { url: `${grpcHost}:${grpcPort}`, transport: "GRPC" },
    ],
  };

  // Phase 3: Advertise memory-query capability
  if (config.memoryQuery?.enabled && config.learningSync?.enabled) {
    card.skills.push({
      id: "memory-query",
      name: "Memory Query",
      description: "Search this agent's memory store via POST /a2a/memory/query",
      tags: ["memory", "search", "openclaw"],
      examples: ["Search for notes about deployment", "Find memories from 2026-03-16"],
    });

    (card as any).extensions = {
      "openclaw:memoryQuery": {
        version: "1.0",
        endpoint: "/a2a/memory/query",
        maxResults: config.memoryQuery.maxResults,
        rateLimitPerMinute: config.memoryQuery.rateLimitPerMinute,
      },
    };
  }

  return card;
}
