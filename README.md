# memory-lancedb-pro-codex

Codex adaptation of [`memory-lancedb-pro`](https://github.com/win4r/memory-lancedb-pro).

This repository turns the original OpenClaw long-term memory engine into a Codex-oriented workflow with:

- a Codex MCP server wrapper
- repo-local plugin metadata
- repo-local and user-local skills for `/memory` and `$memory`
- `AGENTS.md` guidance so Codex recalls prior work before broad exploration and stores durable lessons after fixes

## What Changed vs Upstream

Compared with the upstream `memory-lancedb-pro`, this repo adds a Codex-specific layer on top of the original LanceDB engine:

- `memory-lancedb-pro/codex/runtime-adapter.ts`: Codex runtime bridge
- `memory-lancedb-pro/dist-codex/runtime/`: compiled runtime used by the MCP wrapper
- `plugins/memory-lancedb-pro/`: Codex plugin bundle with `.codex-plugin/plugin.json`, `.mcp.json`, icons, skill, and MCP entrypoint
- `.codex/skills/memory/`: repo-local skill for explicit `$memory` and `/memory`
- `.agents/plugins/marketplace.json`: repo-local plugin marketplace entry
- `AGENTS.md`: repo-level memory workflow instructions

The runtime exposes these tools:

- `memory_health`
- `memory_recall`
- `memory_extract_and_store`
- `memory_store`
- `memory_update`
- `memory_forget`
- `memory_list`
- `memory_stats`

## Repository Layout

```text
.
├── memory-lancedb-pro/              # adapted memory engine
│   ├── src/                         # original engine sources + local fixes
│   ├── codex/                       # Codex runtime adapter source
│   ├── dist-codex/runtime/          # compiled runtime used by the plugin wrapper
│   └── test/                        # upstream tests + Codex smoke tests
├── plugins/memory-lancedb-pro/      # Codex plugin wrapper
│   ├── .codex-plugin/plugin.json
│   ├── .mcp.json
│   ├── scripts/mcp-server.mjs
│   └── config.example.json
├── .codex/skills/memory/            # repo-local explicit memory skill
├── .agents/plugins/marketplace.json # repo-local plugin entry
└── AGENTS.md                        # repo-level default memory workflow
```

## Prerequisites

- Codex CLI or Codex Desktop with MCP support enabled
- Node.js 20+ recommended
- A working embedding provider using the OpenAI-compatible API shape
- An LLM endpoint if you want `memory_extract_and_store`

The sample config is OpenAI-compatible. DashScope works as long as you point `baseURL`, `model`, and credentials at the correct endpoints.

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/win4r/memory-lancedb-pro-codex.git
cd memory-lancedb-pro-codex
```

### 2. Create local config

Copy the example config:

```bash
cp plugins/memory-lancedb-pro/config.example.json plugins/memory-lancedb-pro/config.json
```

Then fill in:

- `embedding.apiKey`
- `embedding.model`
- `embedding.baseURL`
- `llm.apiKey`
- `llm.model`
- `llm.baseURL`
- optional rerank settings under `retrieval`

The live config file is intentionally excluded from git.

### 3. Register the MCP server globally

From any shell:

```bash
codex mcp add memory-lancedb-pro -- node /absolute/path/to/plugins/memory-lancedb-pro/scripts/mcp-server.mjs
```

For example, if you cloned this repo to `/Users/alice/code/memory-lancedb-pro-codex`:

```bash
codex mcp add memory-lancedb-pro -- node /Users/alice/code/memory-lancedb-pro-codex/plugins/memory-lancedb-pro/scripts/mcp-server.mjs
```

### 4. Start a new Codex thread

Use a new thread or restart Codex so it reloads:

- the global MCP server
- the repo `AGENTS.md`
- the repo and user skills

### 5. Use memory explicitly

The closest native interaction model in Codex is:

- `/memory`
- `$memory`
- `@memory recall <query>`
- `@memory store <text>`

Important: `@memory` here is a prompt-level alias handled by the skill and `AGENTS.md`. It is not a native app-backed `@` picker chip.

## How It Works

### Automatic behavior inside this repo

`AGENTS.md` tells Codex to:

- run `memory_recall` before broad repo exploration when prior context may matter
- store durable fixes and decisions after work completes
- treat `@memory`, `$memory`, and `/memory` as explicit memory requests

### Explicit behavior

Use the memory skill when you want the workflow to be obvious in the transcript:

- `/memory`
- `$memory`

Then follow with a plain request such as:

- `@memory recall FTS cold start`
- `@memory list`
- `@memory health`

### Tool behavior

- `memory_store` needs embeddings
- `memory_update` text changes need embeddings
- `memory_extract_and_store` needs embeddings plus an LLM config
- `memory_recall` can fall back to lexical search if embeddings are unavailable

## Configuration Notes

The plugin wrapper searches config in this order:

1. `MEMORY_LANCEDB_PRO_CONFIG`
2. `plugins/memory-lancedb-pro/config.json`
3. `~/.codex/memory-lancedb-pro/config.json`

See the plugin-level guide for more detail:

- [`plugins/memory-lancedb-pro/README.md`](./plugins/memory-lancedb-pro/README.md)

## Testing

### Compile the Codex runtime

```bash
npx tsc -p memory-lancedb-pro/codex/tsconfig.json
```

### Run the basic Codex smoke test

This verifies:

- health
- embedding connectivity
- write
- recall

```bash
node memory-lancedb-pro/test/codex-memory-smoke.mjs --basic
```

### Optional cleanup for the dedicated smoke scope

```bash
node memory-lancedb-pro/test/codex-memory-smoke.mjs --cleanup-only
```

### Run the broader upstream test suite

```bash
cd memory-lancedb-pro
npm test
```

## Limitations

- This is not a true app-backed Codex `@` plugin. A native `@` picker entry would require a real OpenAI app or connector id and `.app.json` wiring.
- The intended explicit entrypoints are `/memory` and `$memory`.
- `@memory ...` is supported as a text alias, not as a native picker-backed app mention.
- Smart extraction quality depends on the configured LLM and prompt fidelity.

## Security

- `plugins/memory-lancedb-pro/config.json` is ignored by git
- `.memory-lancedb-pro/` is ignored by git
- this repository does not include live API keys
- do not store API keys, tokens, or private credentials as memory content

## License

The adapted engine package declares `MIT` in `memory-lancedb-pro/package.json`. If you plan to redistribute this repository as a standalone public package, add a top-level `LICENSE` file as well.
