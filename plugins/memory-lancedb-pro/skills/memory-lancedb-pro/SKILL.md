---
name: memory-lancedb-pro
description: Persistent LanceDB-backed memory workflow for Codex. Use for repo work where prior fixes, decisions, preferences, or follow-up context may matter, and whenever the user types `@memory` or asks what was done before.
---

# Memory LanceDB Pro

Use this skill when the task benefits from durable memory across Codex sessions.

## Workflow

1. Before broad repo exploration, call `memory_recall` with the current bug, feature, repo, or error keywords if prior work may already exist.
2. Skip recall only when the task is obviously one-off and prior context is unlikely to help.
3. After resolving a bug, decision, or stable preference, prefer `memory_extract_and_store` with a short summary transcript. Use `memory_store` only for one short atomic memory.
4. Use explicit scopes when the memory should stay local:
   - `global` for cross-project knowledge
   - `project:<slug>` for repo-specific memory
   - `custom:<slug>` for any other partition you want to control manually
5. Use `memory_health` when writes or recall fail, especially right after install or when embedding credentials changed.

## `@memory` Convention

Treat a user prefix like `@memory` or `@记忆` as a direct request to interact with the memory system, even if the native Codex app picker does not show a memory app chip.

Common mappings:

- `@memory recall <query>` -> call `memory_recall`
- `@memory store <text>` -> call `memory_store`
- `@memory extract <transcript>` -> call `memory_extract_and_store`
- `@memory list` -> call `memory_list`
- `@memory stats` -> call `memory_stats`
- `@memory health` -> call `memory_health`
- `@memory forget <id>` -> call `memory_forget`

When the user intent is clear, do not ask them to restate the request in tool-shaped JSON.

## Writing Guidance

- Prefer concise, reusable memories.
- Split raw fact and actionable rule into separate entries when both matter.
- Avoid storing transient logs, stack traces, or long conversational summaries unless they are the actual durable artifact.
- Never store secrets, API keys, access tokens, or private credentials.

## Tool Map

- `memory_recall`: search existing memory
- `memory_extract_and_store`: extract memories from a conversation transcript and persist them
- `memory_store`: persist a new memory
- `memory_update`: fix or refine a stored memory
- `memory_forget`: delete stale or wrong memory
- `memory_list`: inspect recent entries
- `memory_stats`: check store shape and counts
- `memory_health`: validate runtime and embedding connectivity
