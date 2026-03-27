# Admission Control 指南

本文说明 `memory-lancedb-pro` 中的 A-MAC 风格 admission-control 层。

这份文档偏实用和运维视角，重点回答：
- admission 运行在什么位置
- 它评估哪些特征
- 应该怎么配置
- 上线后如何观测
- 它不会替代哪些现有能力

## 1. 目标

admission control 的目标，是在 smart extraction 写路径上减少低价值记忆写入。

这个插件原本就已经有 downstream dedup、merge、support、contextualize、contradict 等能力。admission **不是**去替代它们，而是在更前面加一层治理：

```text
conversation/session
-> smart extraction
-> admission scoring
-> reject 或 pass_to_dedup
-> 现有 downstream dedup / persistence flow
```

这意味着：
- 低价值候选可以在真正落库前被拦掉
- 被放行的候选仍然沿用现有写入语义
- 插件原有更丰富的 downstream 状态机不会被抹平

## 2. 决策语义

目前 admission 的实际操作决策只有两种：

- `reject`
- `pass_to_dedup`

另外还有一个仅用于审计的 hint：

- `add`
- `update_or_merge`

这个 hint 只用于观测，不会替代 downstream 的实际分支。也就是说，下游这些状态依旧保留：
- `create`
- `merge`
- `skip`
- `support`
- `contextualize`
- `contradict`

## 3. 特征模型

admission 目前使用五个特征，设计上参考 A-MAC 论文：

### Utility

判断这个候选在未来跨会话交互里是否大概率有用。

在 v1.1 中，当 `utilityMode = "standalone"` 时，这个特征通过独立 LLM 调用计算。

### Confidence

衡量候选内容与源对话之间的证据/支持程度。

它**不是**模型自报的“我有多确定”，而是更接近 grounded support 的分数。

### Novelty

衡量这个候选相对已有相近记忆是否足够“新”。

插件复用了现有 embedding 和 vector search 基础设施来做这个计算。

### Recency

衡量这个候选相对于相似已有记忆是否足够新。

这是一个轻量特征，由 `recency.halfLifeDays` 控制。

### Type Prior

根据 memory category 给一个先验分数：
- `profile`
- `preferences`
- `entities`
- `events`
- `cases`
- `patterns`

这个先验让系统更偏向长期有价值的记忆类型，而不是短暂噪声。

## 4. Preset

插件当前内置三档 preset：

### `balanced`

推荐默认值。

适合：
- 想先用一套稳妥配置上线
- 既不想噪声太多，也不想漏记太多
- 希望先看真实流量再调参

### `conservative`

更偏 precision。

适合：
- 更担心脏数据进入长期存储
- 希望在早期 rollout 时先把库控干净
- 接受更多边界候选被拒绝

### `high-recall`

更偏 recall。

适合：
- 更担心漏掉 profile / preference 这类高价值记忆
- 接受更多候选进入 downstream dedup
- 愿意持续盯审计结果

preset 会先提供默认参数，但你显式写的配置字段仍然会覆盖 preset。

## 5. 推荐起步配置

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

如果你更在意 precision：

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "conservative"
  }
}
```

如果你更在意 recall：

```json
{
  "admissionControl": {
    "enabled": true,
    "preset": "high-recall"
  }
}
```

## 6. 上线后的可观测性

admission 的可观测性主要有三层。

### 被放行的记忆

当 `auditMetadata = true` 时，被放行的 memory 会写入 `metadata.admission_control`，其中包括：
- 总分
- 各特征分
- 阈值
- 决策
- hint
- reason
- evaluated timestamp
- compared / matched memory ids

### 被拒绝的候选

当 `persistRejectedAudits = true` 时，被拒绝的候选会追加写入 JSONL reject audit 文件。

默认路径：

```text
<dbPath>/../admission-audit/rejections.jsonl
```

如果需要，也可以用 `admissionControl.rejectedAuditFilePath` 自定义。

### CLI 和工具统计

常用命令：

```bash
openclaw memory-pro stats --json
openclaw memory-pro admission-rejections --stats --json
openclaw memory-pro admission-rejections --tail 20
openclaw memory-pro admission-rejections --since 24h
openclaw memory-pro admission-rejections --reason-contains unsupported
```

`memory_stats` 工具也会暴露 admission summary，便于 agent 侧查看。

当前 summary 包括：
- admitted count
- rejected count
- reject rate
- top rejection reasons
- 最近时间窗口（`last24h`、`last7d`）
- category breakdown

## 7. 建议的 rollout 顺序

推荐这样上线：

1. 先启用 `preset = "balanced"`
2. 保持 `auditMetadata` 和 `persistRejectedAudits` 都开启
3. 先跑一段真实流量，不要第一天就改很多参数
4. 重点观察：
   - `rejectRate`
   - top rejection reasons
   - category breakdown
5. 调参顺序建议：
   - `rejectThreshold`
   - `typePriors`
   - feature `weights`

经验规则：
- 如果好记忆被拦太多，优先先降 `rejectThreshold`
- 如果短期事件进来太多，优先降 `typePriors.events`
- 不要一次改很多 knob，否则很难判断是哪一项生效

## 8. 几个关键设计选择

### regex fallback 不会绕过 admission rejection

如果 admission 把当前提取出的候选全部拒绝，插件不会再让这些候选掉回 regex fallback。

这是有意为之。否则治理层会被绕过。

### admission confidence 不等于生命周期 confidence

admission 里的 confidence 是支持度/证据度特征，用于打分和审计。

它**不会**直接复用为 decay scoring 使用的生命周期 confidence。存储在 memory metadata 里的 confidence 仍保持原有生命周期语义。

## 9. 当前范围与延期项

这层 admission 是刻意收敛过范围的。

它目前**不**试图做这些事：
- 替代 downstream dedup 语义
- 在线学习或强化优化
- 建 replay/eval harness
- 自动做 reject audit log rotation
- 把所有写路径都统一纳入 admission

这些都属于后续可增强项，不是 v1.1 的目标。

## 10. 隐私与运维提醒

有两条现实中的运维提醒要注意：

- reject audit JSONL 会持续追加，如果长期高流量运行，需要自己做 rotation
- reject audit 会保存一段截断后的 conversation excerpt 方便排查

如果你部署在敏感环境，应该明确谁能读取这个 reject audit 文件，以及是否需要外部日志轮转策略。
