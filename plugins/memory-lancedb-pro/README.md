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
    "apiKey": "ollama-local",
    "model": "mxbai-embed-large",
    "baseURL": "http://localhost:11434/v1",
    "dimensions": 1024
  },
  "llm": {
    "apiKey": "${CPA_API_KEY}",
    "model": "deepseek-v4-flash",
    "baseURL": "http://127.0.0.1:8317/v1"
  },
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "rerank": "none",
    "candidatePoolSize": 20,
    "minScore": 0.3,
    "hardMinScore": 0.35
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
  "extractMinMessages": 4,
  "extractMaxChars": 4000
}
```

## Environment Variables

The config file supports `${VAR}` template resolution at runtime. The following variables are commonly used:

| Variable | Description | Example |
|---|---|---|
| `CPA_API_KEY` | API key for the CPA proxy LLM endpoint | `sk-...` |
| `LLM_MODEL` | LLM model served via the CPA proxy | `deepseek-v4-flash` |
| `LLM_BASE_URL` | LLM endpoint base URL | `http://127.0.0.1:8317/v1` |
| `OPENAI_API_KEY` | OpenAI-compatible embedding API key (if not using Ollama) | `sk-...` |

You can also override config fields via `MEMORY_LANCEDB_PRO_*` environment variables:

| Env Variable | Overrides |
|---|---|
| `MEMORY_LANCEDB_PRO_CONFIG` | Full path to a config file (highest priority) |
| `MEMORY_LANCEDB_PRO_DB_PATH` | `dbPath` |
| `MEMORY_LANCEDB_PRO_EMBEDDING_API_KEY` | `embedding.apiKey` |
| `MEMORY_LANCEDB_PRO_LLM_API_KEY` | `llm.apiKey` |
| `MEMORY_LANCEDB_PRO_LLM_MODEL` | `llm.model` |
| `MEMORY_LANCEDB_PRO_LLM_BASE_URL` | `llm.baseURL` |

### .env auto-loading

The MCP server auto-loads `~/.openclaw/.env` at startup. Set variables in that file:

```bash
# ~/.openclaw/.env
LLM_MODEL=deepseek-v4-flash
LLM_BASE_URL=http://127.0.0.1:8317/v1
CPA_API_KEY=sk-...
```

Variables already present in `process.env` (e.g. set by a wrapper script) take priority over `.env` values.

Set these before starting the MCP server. The runtime resolves them in `buildEnvConfig()`.

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
