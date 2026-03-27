---
name: memory
description: Recall and store long-term memory in Codex using the memory-lancedb-pro MCP tools. Use when the user asks what happened before, wants to continue prior work, asks to remember a fix or preference, or types `@memory`.
metadata:
  short-description: Recall and store long-term memory for this repo
---

# Memory

Use this skill to make persistent memory feel like a first-class Codex workflow.

## Explicit Invocation

- Typing `$memory` explicitly invokes this skill.
- In the Codex app, enabled skills also appear in the slash command list, so `/memory` should activate this skill in a new thread after reload.
- Treat plain text `@memory` or `@记忆` as a user-facing alias for this skill even though it is not a native app-backed `@` chip.

## Default Workflow

1. Before broad repo exploration, call `memory_recall` if prior fixes, decisions, or preferences may matter.
2. Use scope `project:new-project` unless there is a better repo-specific slug in the current task.
3. After a durable fix, decision, or stable preference, prefer `memory_extract_and_store` with a short summary transcript.
4. Use `memory_store` only for a single short atomic memory.
5. Use `memory_health` if recall or writes fail.

## Fast Mappings

- `@memory recall <query>`: call `memory_recall`
- `@memory store <text>`: call `memory_store`
- `@memory extract <summary>`: call `memory_extract_and_store`
- `@memory list`: call `memory_list`
- `@memory stats`: call `memory_stats`
- `@memory health`: call `memory_health`
- `@memory forget <id>`: call `memory_forget`

## Writing Rules

- Prefer concise, reusable memories.
- Split facts and rules into separate memories when both matter.
- Do not store secrets, API keys, tokens, or private credentials.
