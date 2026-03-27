# memory-lancedb-pro-codex

Codex adaptation of [`memory-lancedb-pro`](https://github.com/win4r/memory-lancedb-pro).

This repository packages two layers together:

- `memory-lancedb-pro/`: the adapted LanceDB memory engine with Codex runtime glue in `codex/` and built runtime output in `dist-codex/`
- `plugins/memory-lancedb-pro/`: the Codex plugin wrapper that exposes the memory engine as an MCP server

It also includes:

- `.agents/plugins/marketplace.json`: repo-local plugin marketplace entry
- `.codex/skills/memory/`: repo-local skill for `/memory` and `$memory`
- `AGENTS.md`: repo-level guidance that makes Codex recall memory before broad exploration and store durable lessons after fixes

## Main Capabilities

- persistent memory storage in LanceDB
- hybrid retrieval with vector + lexical scoring
- explicit `memory_store`, `memory_recall`, `memory_update`, `memory_forget`, `memory_list`, `memory_stats`, `memory_health`
- smart transcript extraction through `memory_extract_and_store`
- Codex-oriented workflow via MCP, skills, and `AGENTS.md`

## Local Setup

1. Add the MCP server globally:

```bash
codex mcp add memory-lancedb-pro -- node /absolute/path/to/plugins/memory-lancedb-pro/scripts/mcp-server.mjs
```

2. Copy `plugins/memory-lancedb-pro/config.example.json` to `plugins/memory-lancedb-pro/config.json`

3. Fill in your embedding, rerank, and LLM credentials

4. Restart Codex or start a new thread

Then use:

- `/memory`
- `$memory`
- `@memory recall <query>`

## Notes

- `plugins/memory-lancedb-pro/config.json` is intentionally excluded from git
- `.memory-lancedb-pro/` is intentionally excluded from git
- this repo does not contain any live API keys
