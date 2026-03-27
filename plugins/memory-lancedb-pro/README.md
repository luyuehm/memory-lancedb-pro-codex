# Memory LanceDB Pro Codex Plugin

This plugin adapts the OpenClaw `memory-lancedb-pro` long-term memory engine into a Codex-native MCP server.

It keeps the original LanceDB storage, hybrid retrieval, and multi-scope model, but exposes them as Codex tools instead of OpenClaw lifecycle hooks.

## What You Get

- Codex plugin manifest at `.codex-plugin/plugin.json`
- local stdio MCP server at `./scripts/mcp-server.mjs`
- runtime adapter compiled from `memory-lancedb-pro/src/*`
- tool surface:
  - `memory_health`
  - `memory_recall`
  - `memory_extract_and_store`
  - `memory_store`
  - `memory_update`
  - `memory_forget`
  - `memory_list`
  - `memory_stats`

## Config Search Order

The MCP server loads config from the first path that exists:

1. `MEMORY_LANCEDB_PRO_CONFIG`
2. `plugins/memory-lancedb-pro/config.json`
3. `~/.codex/memory-lancedb-pro/config.json`

Default `dbPath` is `~/.openclaw/memory/lancedb-pro`, so an existing OpenClaw memory database can be reused directly.

## Minimal Config

Copy `config.example.json` to `config.json` and replace the placeholders:

```json
{
  "dbPath": "~/.openclaw/memory/lancedb-pro",
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small",
    "baseURL": "https://api.openai.com/v1"
  },
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4.1-mini",
    "baseURL": "https://api.openai.com/v1"
  },
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "rerank": "none",
    "candidatePoolSize": 12
  },
  "scopes": {
    "default": "global",
    "definitions": {
      "global": {
        "description": "Shared memory across Codex sessions"
      }
    },
    "agentAccess": {}
  },
  "smartExtraction": true,
  "extractMinMessages": 2,
  "extractMaxChars": 8000
}
```

## Notes

- `memory_store` and text-changing `memory_update` require embedding config.
- `memory_extract_and_store` requires both embeddings and an LLM config. `llm.apiKey` can reuse the same key as `embedding.apiKey`.
- If embedding config is absent, `memory_recall` falls back to BM25-only search over existing memory text.
- Scope values follow the original plugin conventions: `global`, `project:<id>`, `custom:<id>`, `user:<id>`, `agent:<id>`.

## Codex Desktop Integration

For a reliable Codex Desktop setup, prefer registering the server as a global MCP endpoint:

```bash
codex mcp add memory-lancedb-pro -- node /absolute/path/to/plugins/memory-lancedb-pro/scripts/mcp-server.mjs
```

This avoids relying on the desktop app's local plugin marketplace import behavior.

For the closest native interaction in Codex App:

- use `$memory` to explicitly invoke the memory skill
- use `/memory` from the slash command list after restarting into a new thread
- keep `@memory ...` as a plain-text alias interpreted by the memory skill and `AGENTS.md`

For workspace automation, add an `AGENTS.md` file that tells Codex to:

- run `memory_recall` before broad repo exploration when prior work may matter
- run `memory_extract_and_store` or `memory_store` after durable fixes or decisions
- treat plain text prefixes like `@memory` or `@记忆` as direct memory requests

The `@memory` convention is a prompt-level alias, not a native app-backed `@` chip in the Codex picker.
