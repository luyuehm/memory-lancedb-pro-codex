#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createCodexMemoryRuntime } from "../../../memory-lancedb-pro/dist-codex/runtime/codex/runtime-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, "..");
const homeDir = process.env.HOME || process.env.USERPROFILE || "";
const configCandidates = [
  join(pluginRoot, "config.json"),
  homeDir ? join(homeDir, ".codex", "memory-lancedb-pro", "config.json") : "",
].filter(Boolean);

const SERVER_INFO = {
  name: "memory-lancedb-pro",
  version: "1.1.0-codex.1",
};

const CATEGORY_ENUM = [
  "preference",
  "fact",
  "decision",
  "entity",
  "reflection",
  "other",
];

let runtimePromise;

function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = createCodexMemoryRuntime({
      configPathCandidates: configCandidates,
    });
  }
  return runtimePromise;
}

function makeTextResult(text, structuredContent, isError = false) {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

function summarizeMemory(memory, index) {
  const prefix = typeof index === "number" ? `${index + 1}. ` : "";
  const score = typeof memory.score === "number" ? ` score=${memory.score.toFixed(3)}` : "";
  return `${prefix}[${memory.id}] [${memory.category}:${memory.scope}]${score} ${memory.text}`;
}

function toolDefinitions() {
  return [
    {
      name: "memory_health",
      description: "Show memory runtime configuration, storage path, and optional embedding connectivity.",
      inputSchema: {
        type: "object",
        properties: {
          testEmbeddings: {
            type: "boolean",
            description: "When true, send a test embedding request to validate upstream connectivity.",
            default: false,
          },
        },
      },
    },
    {
      name: "memory_recall",
      description: "Search persistent memories with hybrid retrieval. Falls back to BM25-only if embedding config is absent.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search query or anchor phrase.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 5,
          },
          scope: {
            type: "string",
            description: "Optional scope such as global, project:<id>, custom:<id>, user:<id>, or agent:<id>.",
          },
          category: {
            type: "string",
            enum: CATEGORY_ENUM,
          },
        },
      },
    },
    {
      name: "memory_extract_and_store",
      description: "Use the OpenClaw SmartExtractor to extract durable memories from a conversation transcript and store them.",
      inputSchema: {
        type: "object",
        required: ["conversationText"],
        properties: {
          conversationText: {
            type: "string",
            description: "Conversation transcript, meeting notes, or multi-turn dialogue to extract memories from.",
          },
          sessionKey: {
            type: "string",
            description: "Optional stable session key stored in memory metadata for dedup tracking.",
          },
          scope: {
            type: "string",
            description: "Scope where new memories should be stored.",
          },
          scopeFilter: {
            type: "array",
            description: "Optional scopes visible to dedup and merge checks. Defaults to the target scope.",
            items: {
              type: "string",
            },
          },
        },
      },
    },
    {
      name: "memory_store",
      description: "Persist a new memory entry into LanceDB. Requires embedding config.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description: "Atomic memory text to persist.",
          },
          category: {
            type: "string",
            enum: CATEGORY_ENUM,
            default: "other",
          },
          scope: {
            type: "string",
            description: "Optional scope. Defaults to the configured default scope.",
          },
          importance: {
            type: "number",
            minimum: 0,
            maximum: 1,
            default: 0.7,
          },
          metadata: {
            type: "object",
            description: "Optional metadata object stored as JSON beside the memory.",
            additionalProperties: true,
          },
        },
      },
    },
    {
      name: "memory_update",
      description: "Update text, category, importance, or metadata for an existing memory id.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "Full memory id or disambiguated id prefix.",
          },
          text: {
            type: "string",
          },
          category: {
            type: "string",
            enum: CATEGORY_ENUM,
          },
          importance: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          metadata: {
            type: "object",
            additionalProperties: true,
          },
          metadataPatch: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    {
      name: "memory_forget",
      description: "Delete a memory by id or id prefix.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
          },
          scope: {
            type: "string",
            description: "Optional scope guard for the delete operation.",
          },
        },
      },
    },
    {
      name: "memory_list",
      description: "List stored memories ordered by recency.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
          },
          category: {
            type: "string",
            enum: CATEGORY_ENUM,
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 20,
          },
          offset: {
            type: "integer",
            minimum: 0,
            default: 0,
          },
        },
      },
    },
    {
      name: "memory_stats",
      description: "Return counts by scope and category together with FTS health information.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
          },
        },
      },
    },
  ];
}

const TOOL_HANDLERS = {
  async memory_health(args = {}) {
    const runtime = await getRuntime();
    const report = await runtime.health(Boolean(args.testEmbeddings));
    const lines = [
      `dbPath: ${report.dbPath}`,
      `defaultScope: ${report.defaultScope}`,
      `configPath: ${report.configPath || "(none)"}`,
      `embeddingConfigured: ${report.embeddingConfigured}`,
      `retrievalMode: ${report.retrievalMode}`,
      `vectorDimensions: ${report.vectorDimensions}`,
      `ftsAvailable: ${report.ftsAvailable}`,
    ];
    if (report.ftsError) {
      lines.push(`ftsError: ${report.ftsError}`);
    }
    if (report.embedderTest) {
      lines.push(
        `embedderTest: ${report.embedderTest.success ? "ok" : `failed (${report.embedderTest.error})`}`,
      );
    }
    return makeTextResult(lines.join("\n"), report);
  },

  async memory_recall(args = {}) {
    const runtime = await getRuntime();
    const result = await runtime.recall(args);
    if (!result.memories.length) {
      return makeTextResult("No relevant memories found.", result);
    }
    const lines = [
      `Retrieved ${result.memories.length} memory item(s) via ${result.mode}.`,
      ...result.memories.map((memory, index) => summarizeMemory(memory, index)),
    ];
    return makeTextResult(lines.join("\n"), result);
  },

  async memory_store(args = {}) {
    const runtime = await getRuntime();
    const stored = await runtime.storeMemory(args);
    return makeTextResult(
      `Stored memory [${stored.id}] in scope ${stored.scope}.`,
      stored,
    );
  },

  async memory_extract_and_store(args = {}) {
    const runtime = await getRuntime();
    const result = await runtime.extractAndStoreMemories(args);
    const lines = [
      `Processed conversation into long-term memory for scope ${result.scope}.`,
      `sessionKey: ${result.sessionKey}`,
      `created: ${result.created}`,
      `merged: ${result.merged}`,
      `skipped: ${result.skipped}`,
      `supported: ${result.supported}`,
      `superseded: ${result.superseded}`,
      `rejected: ${result.rejected}`,
      `handled: ${result.handled}`,
    ];
    return makeTextResult(lines.join("\n"), result);
  },

  async memory_update(args = {}) {
    const runtime = await getRuntime();
    const updated = await runtime.updateMemory(args);
    return makeTextResult(
      `Updated memory [${updated.id}] in scope ${updated.scope}.`,
      updated,
    );
  },

  async memory_forget(args = {}) {
    const runtime = await getRuntime();
    const result = await runtime.forgetMemory(args);
    return makeTextResult(
      result.deleted
        ? `Deleted memory ${result.id}.`
        : `Memory ${result.id} was not found.`,
      result,
    );
  },

  async memory_list(args = {}) {
    const runtime = await getRuntime();
    const result = await runtime.listMemories(args);
    if (!result.memories.length) {
      return makeTextResult("No memories found.", result);
    }
    const lines = [
      `Listed ${result.memories.length} memory item(s).`,
      ...result.memories.map((memory, index) => summarizeMemory(memory, index)),
    ];
    return makeTextResult(lines.join("\n"), result);
  },

  async memory_stats(args = {}) {
    const runtime = await getRuntime();
    const result = await runtime.stats(args);
    const lines = [
      `totalCount: ${result.totalCount}`,
      `dbPath: ${result.dbPath}`,
      `defaultScope: ${result.defaultScope}`,
      `ftsAvailable: ${result.ftsStatus.available}`,
      `scopeCounts: ${JSON.stringify(result.scopeCounts)}`,
      `categoryCounts: ${JSON.stringify(result.categoryCounts)}`,
    ];
    if (result.ftsStatus.lastError) {
      lines.push(`ftsError: ${result.ftsStatus.lastError}`);
    }
    return makeTextResult(lines.join("\n"), result);
  },
};

function writeMessage(payload) {
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, "utf8");
  process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${json}`);
}

function writeError(id, code, message, data) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

async function handleRequest(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  const method = message.method;
  const params = message.params || {};

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "initialize") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false,
          },
          logging: {},
        },
        serverInfo: SERVER_INFO,
        instructions:
          "Persistent LanceDB-backed memory for Codex. Configure embeddings for writes/recall and add an llm block to enable conversation extraction.",
      },
    });
    return;
  }

  if (method === "ping") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {},
    });
    return;
  }

  if (method === "logging/setLevel") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {},
    });
    return;
  }

  if (method === "tools/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        tools: toolDefinitions(),
      },
    });
    return;
  }

  if (method === "resources/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        resources: [],
      },
    });
    return;
  }

  if (method === "prompts/list") {
    writeMessage({
      jsonrpc: "2.0",
      id,
      result: {
        prompts: [],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const toolName = params.name;
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      writeError(id, -32601, `Unknown tool: ${toolName}`);
      return;
    }
    try {
      const result = await handler(params.arguments || {});
      writeMessage({
        jsonrpc: "2.0",
        id,
        result,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      writeMessage({
        jsonrpc: "2.0",
        id,
        result: makeTextResult(messageText, { error: messageText }, true),
      });
    }
    return;
  }

  if (id !== undefined) {
    writeError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = Buffer.alloc(0);

function processBuffer() {
  for (;;) {
    const separatorIndex = buffer.indexOf("\r\n\r\n");
    if (separatorIndex === -1) {
      return;
    }

    const headerText = buffer.slice(0, separatorIndex).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(headerText);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number(match[1]);
    const bodyStart = separatorIndex + 4;
    const bodyEnd = bodyStart + contentLength;
    if (buffer.length < bodyEnd) {
      return;
    }

    const payload = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    buffer = buffer.slice(bodyEnd);

    let message;
    try {
      message = JSON.parse(payload);
    } catch (error) {
      process.stderr.write(`memory-lancedb-pro MCP: failed to parse JSON payload: ${String(error)}\n`);
      continue;
    }

    void handleRequest(message).catch((error) => {
      process.stderr.write(`memory-lancedb-pro MCP: unhandled request failure: ${String(error)}\n`);
      if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
        writeError(message.id, -32603, error instanceof Error ? error.message : String(error));
      }
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  processBuffer();
});

process.stdin.on("end", () => {
  process.exit(0);
});
