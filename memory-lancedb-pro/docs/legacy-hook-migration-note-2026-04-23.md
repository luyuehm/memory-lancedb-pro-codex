# Legacy hook migration note (2026-04-23)

`openclaw plugins doctor` reports that `memory-lancedb-pro` still uses legacy `before_agent_start`.

Local inspection suggests this is not just dead code cleanup. The plugin still appears to depend on `before_agent_start` for behavior that matters, at least:

- auto-recall
- reflection inheritance injection

The plugin also already uses `before_prompt_build` elsewhere, so current behavior appears to be in a mixed hook-lifecycle state.

## Recommendation

Treat this as staged compatibility work rather than a one-shot warning-silencing cleanup.

Suggested path:

1. inventory remaining `before_agent_start` usage
2. classify what should move to `before_prompt_build` / `before_model_resolve`
3. add regression coverage for recall presence, ordering, and duplicate injection
4. cut over only after validation

## Why

A direct migration may subtly change:

- recall timing
- inherited-rules ordering
- prompt injection order
- duplicate injection behavior

Current behavior appears functional; this looks like compatibility debt, not a runtime outage.
