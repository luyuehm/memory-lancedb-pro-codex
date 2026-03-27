## Memory Workflow

Use the `memory-lancedb-pro` MCP tools for durable project memory in this repository.

Prefer the explicit skill entrypoints `$memory` or `/memory` in new threads when you want memory behavior to be obvious in the transcript.

When to recall first:

- Before broad repo exploration if the task may have prior fixes, decisions, or preferences.
- When the user asks to continue, resume, remember, or check what was done before.
- When the user types `@memory` or `@记忆`.
- When the user invokes `$memory` or `/memory`.

How to use it:

1. Prefer scope `project:new-project` for repo-specific memory.
2. Before broad exploration, call `memory_recall` with the task keywords and the repo scope.
3. After a durable fix, decision, or stable preference, call `memory_extract_and_store` with a short summary transcript, or `memory_store` for one atomic memory.
4. Use `memory_health` if recall or writes fail.

`@memory` convention:

- `@memory recall <query>` means search memory.
- `@memory store <text>` means store one memory.
- `@memory extract <summary>` means extract and store from a short transcript or summary.
- `@memory list`, `@memory stats`, `@memory health`, and `@memory forget <id>` map to the matching memory tools.

`$memory` and `/memory` should activate the same workflow and then interpret any trailing request using the mappings above.

Never store secrets, API keys, tokens, or private credentials in memory.
