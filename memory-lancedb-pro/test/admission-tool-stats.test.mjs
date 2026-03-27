import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { registerMemoryStatsTool } = jiti("../src/tools.ts");

function createHarness(context) {
  const factories = new Map();
  const api = {
    registerTool(factory, meta) {
      factories.set(meta?.name || "", factory);
    },
  };

  registerMemoryStatsTool(api, context);

  return {
    tool(name, toolCtx = {}) {
      const factory = factories.get(name);
      assert.ok(factory, `tool not registered: ${name}`);
      return factory(toolCtx);
    },
  };
}

function buildAuditEntry(overrides = {}) {
  return {
    version: "amac-v1",
    rejected_at: 200,
    session_key: "agent:test:session",
    target_scope: "global",
    scope_filter: ["global"],
    candidate: {
      category: "events",
      abstract: "Weather note",
      overview: "",
      content: "",
    },
    audit: {
      version: "amac-v1",
      decision: "reject",
      score: 0.31,
      reason: "Admission rejected (0.310 < 0.450). Utility: low value weather chatter",
      utility_reason: "Low value weather chatter",
      thresholds: {
        reject: 0.45,
        admit: 0.6,
      },
      weights: {
        utility: 0.1,
        confidence: 0.1,
        novelty: 0.1,
        recency: 0.1,
        typePrior: 0.6,
      },
      feature_scores: {
        utility: 0.1,
        confidence: 0.8,
        novelty: 0.2,
        recency: 0.1,
        typePrior: 0.45,
      },
      matched_existing_memory_ids: [],
      compared_existing_memory_ids: [],
      max_similarity: 0.99,
      evaluated_at: 200,
    },
    conversation_excerpt: "The user mentioned it rained today.",
    ...overrides,
  };
}

describe("memory_stats admission summary", () => {
  let workDir = "";

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = "";
    }
  });

  it("returns admission summary in tool details and text", async () => {
    workDir = mkdtempSync(path.join(tmpdir(), "memory-tool-admission-"));
    const now = Date.now();
    const dbPath = path.join(workDir, "db");
    const auditDir = path.join(workDir, "admission-audit");
    const auditFile = path.join(auditDir, "rejections.jsonl");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      auditFile,
      [
        JSON.stringify(buildAuditEntry({ rejected_at: now - (2 * 60 * 60 * 1000) })),
        JSON.stringify(buildAuditEntry({ rejected_at: now - (3 * 24 * 60 * 60 * 1000) })),
      ].join("\n") + "\n",
      "utf8",
    );

    const harness = createHarness({
      retriever: {
        getConfig() {
          return { mode: "hybrid", rerankApiKey: undefined };
        },
      },
      store: {
        dbPath,
        hasFtsSupport: true,
        async stats() {
          return {
            totalCount: 2,
            scopeCounts: { global: 2 },
            categoryCounts: { preference: 2 },
          };
        },
        async list() {
          return [
            {
              id: "mem-1",
              category: "preference",
              timestamp: now - (3 * 60 * 60 * 1000),
              metadata: JSON.stringify({ admission_control: { decision: "pass_to_dedup", evaluated_at: now - (3 * 60 * 60 * 1000) } }),
            },
            {
              id: "mem-2",
              category: "preference",
              timestamp: now - (8 * 24 * 60 * 60 * 1000),
              metadata: JSON.stringify({ admission_control: { decision: "pass_to_dedup", evaluated_at: now - (8 * 24 * 60 * 60 * 1000) } }),
            },
          ];
        },
      },
      scopeManager: {
        getAccessibleScopes() {
          return ["global"];
        },
        isAccessible() {
          return true;
        },
        getStats() {
          return { totalScopes: 1 };
        },
      },
      embedder: {},
      admissionControl: {
        enabled: true,
        auditMetadata: true,
      },
    });

    const tool = harness.tool("memory_stats");
    const result = await tool.execute("tc-1", {});

    assert.equal(result.details.admission.enabled, true);
    assert.equal(result.details.admission.rejectedCount, 2);
    assert.equal(result.details.admission.admittedCount, 2);
    assert.ok(Math.abs(result.details.admission.rejectRate - 0.5) < 1e-9);
    assert.equal(result.details.admission.topReasons[0].label, "Low value weather chatter");
    assert.equal(result.details.admission.windows.last24h.admittedCount, 1);
    assert.equal(result.details.admission.windows.last24h.rejectedCount, 1);
    assert.equal(result.details.admission.windows.last7d.admittedCount, 1);
    assert.equal(result.details.admission.windows.last7d.rejectedCount, 2);
    assert.equal(result.details.admission.categoryBreakdown.events.admittedCount, 0);
    assert.equal(result.details.admission.categoryBreakdown.events.rejectedCount, 2);
    assert.equal(result.details.admission.categoryBreakdown.preferences.admittedCount, 2);
    assert.equal(result.details.admission.categoryBreakdown.preferences.rejectedCount, 0);
    assert.match(result.content[0].text, /Admission summary:/);
    assert.match(result.content[0].text, /Top rejection reasons:/);
    assert.match(result.content[0].text, /Recent windows:/);
    assert.match(result.content[0].text, /Observed by category:/);
  });
});
