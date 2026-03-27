# Admission Control Guide

This document describes the A-MAC-style admission-control layer in `memory-lancedb-pro`.

It is intentionally practical and operational. The goal is to explain:
- where admission runs
- what it scores
- how to configure it
- how to observe it in production
- what it does not try to replace

## 1. Purpose

Admission control exists to reduce low-value memory writes on the smart-extraction path.

The plugin already had downstream dedup, merge, support, contextualize, and contradiction handling. Admission does **not** replace that logic. Instead, it adds an earlier governance step:

```text
conversation/session
-> smart extraction
-> admission scoring
-> reject or pass_to_dedup
-> existing downstream dedup / persistence flow
```

This means:
- low-value candidates can be rejected before they ever reach storage
- admitted candidates still use the existing write semantics
- the plugin remains backward-compatible with its richer downstream decision pipeline

## 2. Decision Semantics

Admission currently supports two operational decisions:

- `reject`
- `pass_to_dedup`

There is also an audit-only hint:

- `add`
- `update_or_merge`

The hint is for observability only. It does **not** replace downstream dedup states such as:
- `create`
- `merge`
- `skip`
- `support`
- `contextualize`
- `contradict`

## 3. Feature Model

Admission uses five features, inspired by the A-MAC paper:

### Utility

Estimates how useful the candidate is likely to be in future cross-session interactions.

In v1.1 this is implemented as a standalone LLM call when `utilityMode = "standalone"`.

### Confidence

Measures evidence/support alignment between the candidate and the source conversation.

This is **not** model self-confidence. It is a support-style heuristic used for admission scoring and audit.

### Novelty

Measures whether the candidate is semantically new compared with nearby existing memories.

The plugin reuses the existing embedding and vector-search path for this calculation.

### Recency

Estimates how fresh the candidate is relative to similar existing memories.

This is intentionally lightweight and controlled by `recency.halfLifeDays`.

### Type Prior

Applies a prior based on the memory category:
- `profile`
- `preferences`
- `entities`
- `events`
- `cases`
- `patterns`

This lets the plugin prefer durable memory types over transient ones.

## 4. Presets

The plugin ships with three presets:

### `balanced`

Recommended default.

Use this when:
- you want a safe starting point
- you need both reasonable precision and reasonable recall
- you want to observe real traffic before tuning

### `conservative`

Favors precision over recall.

Use this when:
- you are more worried about noisy memory writes
- you want to keep the store clean during early rollout
- you do not mind rejecting more borderline candidates

### `high-recall`

Favors recall over precision.

Use this when:
- you are more worried about missing useful profile/preference memory
- you are willing to tolerate more candidates reaching downstream dedup
- you plan to watch audit output closely

Preset values are applied first. Explicit config fields still override the preset.

## 5. Recommended Starting Config

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "balanced",
    "utilityMode": "standalone",
    "auditMetadata": true,
    "persistRejectedAudits": true
  }
}
```

If you need more precision:

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "conservative"
  }
}
```

If you need more recall:

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "high-recall"
  }
}
```

## 6. Operational Observability

Admission behavior is observable in three places.

### Admitted memories

When `auditMetadata = true`, admitted memories include `metadata.admission_control` with:
- final score
- feature scores
- thresholds
- decision
- hint
- reason
- evaluated timestamp
- compared and matched memory ids

### Rejected candidates

When `persistRejectedAudits = true`, rejected candidates are written to a JSONL reject-audit file.

Default location:

```text
<dbPath>/../admission-audit/rejections.jsonl
```

You can override this with `admissionControl.rejectedAuditFilePath`.

### CLI and tool summaries

Useful commands:

```bash
openclaw memory-pro stats --json
openclaw memory-pro admission-rejections --stats --json
openclaw memory-pro admission-rejections --tail 20
openclaw memory-pro admission-rejections --since 24h
openclaw memory-pro admission-rejections --reason-contains unsupported
```

`memory_stats` also exposes admission summary data for agent-side inspection.

The summary includes:
- admitted count
- rejected count
- reject rate
- top rejection reasons
- recent windows (`last24h`, `last7d`)
- category breakdown

## 7. Rollout Guidance

Recommended rollout order:

1. Enable admission with `preset = "balanced"`.
2. Keep both `auditMetadata` and `persistRejectedAudits` enabled.
3. Run real traffic for a while before changing weights.
4. Check:
   - `rejectRate`
   - top rejection reasons
   - category breakdown
5. Tune in this order:
   - `rejectThreshold`
   - `typePriors`
   - feature `weights`

As a rule:
- if too many good memories are blocked, lower `rejectThreshold` first
- if too many transient events get through, reduce `typePriors.events`
- avoid changing many knobs at once

## 8. Important Design Choices

### Regex fallback does not bypass admission rejection

If admission rejects all extracted candidates, the plugin does **not** fall through to regex fallback for those candidates.

This is intentional. Allowing fallback after rejection would bypass the governance layer.

### Admission confidence is not lifecycle confidence

Admission confidence is a support/evidence feature used for scoring and audit.

It is **not** reused as the stored lifecycle confidence used by decay scoring. Stored memory confidence keeps its normal lifecycle semantics.

## 9. Limits and Deferred Work

This layer is intentionally scoped.

It does **not** currently:
- replace downstream dedup behavior
- add online learning or reinforcement tuning
- build a replay/eval harness
- rotate reject audit logs automatically
- unify every possible write path under admission

Those are future improvements, not v1.1 goals.

## 10. Privacy and Operations Notes

Two operational cautions matter in practice:

- reject audits can grow over time because JSONL appends indefinitely
- reject audits include a capped conversation excerpt for debugging

If you deploy in a sensitive environment, document who can read the reject audit file and decide whether you need external log rotation.
