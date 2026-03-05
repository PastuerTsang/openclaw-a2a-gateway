#!/usr/bin/env node
/**
 * Send a message to an A2A peer using the official @a2a-js/sdk.
 *
 * Usage:
 *   node a2a-send.mjs --peer-url <PEER_BASE_URL> --token <TOKEN> --message "Hello!"
 *   node a2a-send.mjs --peer-url http://100.76.43.74:18800 --token abc123 --message "What is your name?"
 *
 * Async task mode (recommended for long-running prompts):
 *   node a2a-send.mjs --peer-url <URL> --token <TOKEN> --non-blocking --wait --message "..."
 *
 * Options:
 *   --peer-url <url>        Peer base URL, e.g. http://100.76.43.74:18800
 *   --token <token>         Bearer token for the peer inbound auth
 *   --message <text>        Text to send
 *   --non-blocking          Send with configuration.blocking=false (returns quickly with a Task)
 *   --wait                  When non-blocking, poll tasks/get until terminal state
 *   --timeout-ms <ms>       Max wait time for --wait (default: 300000)
 *   --poll-ms <ms>          Poll interval for --wait (default: 1000)
 *
 * Optional (OpenClaw extension):
 *   --agent-id <agentId>    Route the inbound A2A request to a specific OpenClaw agentId on the peer.
 *                           Note: this works reliably over JSON-RPC/REST. gRPC transport may drop unknown
 *                           Message fields, so gRPC is disabled when --agent-id is used.
 *
 * Requires: npm install @a2a-js/sdk
 */

import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from "@a2a-js/sdk/client";
import { GrpcTransportFactory } from "@a2a-js/sdk/client/grpc";
import { randomUUID } from "node:crypto";

function usageAndExit(code = 1) {
  console.error(
    "Usage: node a2a-send.mjs --peer-url <URL> --token <TOKEN> --message <TEXT> [--non-blocking] [--wait] [--timeout-ms <ms>] [--poll-ms <ms>] [--agent-id <openclaw-agent-id>]"
  );
  process.exit(code);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;

    const key = arg.replace(/^--/, "");
    const next = args[i + 1];

    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }

  const peerUrl = String(opts["peer-url"] || opts.peerUrl || "").trim();
  const message = String(opts.message || "").trim();
  if (!peerUrl || !message) {
    usageAndExit(1);
  }

  return { ...opts, peerUrl, message };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFirstTextParts(parts) {
  if (!Array.isArray(parts)) return undefined;
  for (const p of parts) {
    if (p && typeof p === "object" && p.kind === "text" && typeof p.text === "string") {
      return p.text;
    }
  }
  return undefined;
}

async function main() {
  const opts = parseArgs();

  const peerUrl = opts.peerUrl;
  const token = typeof opts.token === "string" ? opts.token : "";
  const message = opts.message;
  const targetAgentId = (opts["agent-id"] || opts.agentId || "").toString().trim();

  const nonBlocking = Boolean(opts["non-blocking"] || opts.nonBlocking);
  const wait = Boolean(opts.wait);

  const timeoutMsRaw = opts["timeout-ms"] || opts.timeoutMs;
  const pollMsRaw = opts["poll-ms"] || opts.pollMs;

  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : 300_000;
  const pollMs = pollMsRaw ? Number(pollMsRaw) : 1_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error("Invalid --timeout-ms");
    usageAndExit(2);
  }
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    console.error("Invalid --poll-ms");
    usageAndExit(2);
  }

  // Build auth handler
  const authHandler = token
    ? {
        headers: async () => ({ authorization: `Bearer ${token}` }),
        shouldRetryWithHeaders: async () => undefined,
      }
    : undefined;

  const authFetch = authHandler
    ? createAuthenticatingFetchWithRetry(fetch, authHandler)
    : fetch;

  // If using OpenClaw extension agentId routing, disable gRPC transport to avoid
  // protobuf dropping unknown message fields.
  const transports = targetAgentId
    ? [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
      ]
    : [
        new JsonRpcTransportFactory({ fetchImpl: authFetch }),
        new RestTransportFactory({ fetchImpl: authFetch }),
        new GrpcTransportFactory(),
      ];

  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authFetch }),
      transports,
    })
  );

  // Discover agent card and create client
  const client = await factory.createFromUrl(peerUrl);

  const outboundMessage = {
    kind: "message",
    messageId: randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: message }],
    ...(targetAgentId ? { agentId: targetAgentId } : {}),
  };

  const requestOptions = token ? { serviceParameters: { authorization: `Bearer ${token}` } } : undefined;

  const sendParams = {
    message: outboundMessage,
    ...(nonBlocking ? { configuration: { blocking: false } } : {}),
  };

  const result = await client.sendMessage(sendParams, requestOptions);

  // If the user didn't request waiting, print the immediate response.
  if (!nonBlocking || !wait) {
    if (result?.kind === "message") {
      const text = extractFirstTextParts(result.parts);
      console.log(text || JSON.stringify(result, null, 2));
      return;
    }
    if (result?.kind === "task") {
      const text = extractFirstTextParts(result.status?.message?.parts);
      console.log(text || JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Async task mode: wait for terminal task state via tasks/get.
  const taskId = result?.kind === "task" ? result.id : result?.taskId;
  if (!taskId || typeof taskId !== "string") {
    // Can't wait if we don't know the task id.
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const startedAt = Date.now();
  const terminalStates = new Set(["completed", "failed", "canceled"]);

  while (true) {
    const task = await client.getTask({ id: taskId, historyLength: 20 }, requestOptions);
    const state = task?.status?.state;

    if (state && terminalStates.has(state)) {
      const text = extractFirstTextParts(task.status?.message?.parts);
      console.log(text || JSON.stringify(task, null, 2));
      return;
    }

    if (Date.now() - startedAt > timeoutMs) {
      console.error(`Timeout waiting for task ${taskId} after ${timeoutMs}ms`);
      console.log(JSON.stringify(task, null, 2));
      process.exit(3);
    }

    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error("Error:", err?.stack || err?.message || String(err));
  process.exit(1);
});
