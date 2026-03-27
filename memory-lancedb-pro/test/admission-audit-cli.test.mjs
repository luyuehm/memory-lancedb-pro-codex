import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { createMemoryCLI } = jiti("../cli.ts");

async function captureStdout(run) {
  const chunks = [];
  const originalLog = console.log;
  console.log = (...args) => {
    chunks.push(args.join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return chunks.join("\n");
}

function createProgram(context) {
  const program = new Command();
  program.exitOverride();
  createMemoryCLI(context)({ program });
  return program;
}

function buildAuditEntry(overrides = {}) {
  return {
    version: "amac-v1",
    rejected_at: Date.now(),
    session_key: "agent:test:session",
    target_scope: "global",
    scope_filter: ["global"],
    candidate: {
      category: "events",
      abstract: "Weather note: it rained today",
      overview: "A transient weather update.",
      content: "The user mentioned it rained today.",
    },
    audit: {
      version: "amac-v1",
      decision: "reject",
      score: 0.31,
      reason: "Admission rejected (0.310 < 0.450).",
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
      evaluated_at: Date.now(),
    },
    conversation_excerpt: "The user mentioned it rained today.",
    ...overrides,
  };
}

test("memory-pro admission-rejections reads default audit path and reports stats", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-admission-cli-"));
  try {
    const dbPath = path.join(workDir, "db");
    const auditDir = path.join(workDir, "admission-audit");
    const auditFile = path.join(auditDir, "rejections.jsonl");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      auditFile,
      [
        JSON.stringify(buildAuditEntry({
          target_scope: "global",
          candidate: { category: "events", abstract: "Weather note", overview: "", content: "" },
          audit: {
            ...buildAuditEntry().audit,
            reason: "Admission rejected (0.201 < 0.450). maxSimilarity=1.000. Utility: low value weather chatter",
            utility_reason: "Low value weather chatter",
          },
        })),
        JSON.stringify(buildAuditEntry({
          target_scope: "agent:work",
          candidate: { category: "preferences", abstract: "Editor preference", overview: "", content: "" },
          audit: {
            ...buildAuditEntry().audit,
            reason: "Admission rejected (0.298 < 0.450). maxSimilarity=0.700. Utility: low value weather chatter",
            utility_reason: "Low value weather chatter",
          },
        })),
      ].join("\n") + "\n",
      "utf8",
    );

    const program = createProgram({
      store: { dbPath },
      retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
      scopeManager: { getStats: () => ({ totalScopes: 1 }) },
      migrator: {},
    });

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "admission-rejections",
        "--stats",
        "--json",
      ]);
    });

    const summary = JSON.parse(output);
    assert.equal(summary.filePath, auditFile);
    assert.equal(summary.total, 2);
    assert.equal(summary.byCategory.events, 1);
    assert.equal(summary.byCategory.preferences, 1);
    assert.equal(summary.byScope.global, 1);
    assert.equal(summary.byScope["agent:work"], 1);
    assert.equal(summary.topReasons[0].label, "Low value weather chatter");
    assert.equal(summary.topReasons[0].count, 2);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("memory-pro admission-rejections honors explicit audit file config and newest-first limit", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-admission-cli-custom-"));
  try {
    const dbPath = path.join(workDir, "db");
    const auditFile = path.join(workDir, "custom-rejections.jsonl");
    writeFileSync(
      auditFile,
      [
        JSON.stringify(buildAuditEntry({
          rejected_at: 100,
          candidate: { category: "events", abstract: "Old event", overview: "", content: "" },
        })),
        JSON.stringify(buildAuditEntry({
          rejected_at: 200,
          candidate: { category: "preferences", abstract: "Newest preference", overview: "", content: "" },
        })),
      ].join("\n") + "\n",
      "utf8",
    );

    const program = createProgram({
      store: { dbPath },
      retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
      scopeManager: { getStats: () => ({ totalScopes: 1 }) },
      migrator: {},
      admissionControl: {
        rejectedAuditFilePath: auditFile,
      },
    });

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "admission-rejections",
        "--json",
        "--limit",
        "1",
      ]);
    });

    const payload = JSON.parse(output);
    assert.equal(payload.filePath, auditFile);
    assert.equal(payload.count, 1);
    assert.equal(payload.entries[0].candidate.abstract, "Newest preference");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("memory-pro admission-rejections filters by --since and --reason-contains", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-admission-cli-filters-"));
  try {
    const dbPath = path.join(workDir, "db");
    const auditFile = path.join(workDir, "rejections.jsonl");
    const now = Date.now();
    writeFileSync(
      auditFile,
      [
        JSON.stringify(buildAuditEntry({
          rejected_at: now - (10 * 60_000),
          candidate: { category: "events", abstract: "Old weather note", overview: "", content: "" },
          audit: {
            ...buildAuditEntry().audit,
            reason: "Admission rejected due to transient weather chatter.",
            utility_reason: "Low-value weather chatter",
          },
        })),
        JSON.stringify(buildAuditEntry({
          rejected_at: now - (2 * 60_000),
          candidate: { category: "preferences", abstract: "Recent editor preference", overview: "", content: "" },
          audit: {
            ...buildAuditEntry().audit,
            reason: "Admission rejected due to unsupported tool preference.",
            utility_reason: "Unsupported tool preference detail",
          },
        })),
      ].join("\n") + "\n",
      "utf8",
    );

    const program = createProgram({
      store: { dbPath },
      retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
      scopeManager: { getStats: () => ({ totalScopes: 1 }) },
      migrator: {},
      admissionControl: {
        rejectedAuditFilePath: auditFile,
      },
    });

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "admission-rejections",
        "--json",
        "--since",
        "5m",
        "--reason-contains",
        "unsupported",
      ]);
    });

    const payload = JSON.parse(output);
    assert.equal(payload.count, 1);
    assert.equal(payload.entries[0].candidate.abstract, "Recent editor preference");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("memory-pro admission-rejections supports --tail alias", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-admission-cli-tail-"));
  try {
    const dbPath = path.join(workDir, "db");
    const auditFile = path.join(workDir, "rejections.jsonl");
    writeFileSync(
      auditFile,
      [
        JSON.stringify(buildAuditEntry({
          rejected_at: 100,
          candidate: { category: "events", abstract: "First", overview: "", content: "" },
        })),
        JSON.stringify(buildAuditEntry({
          rejected_at: 200,
          candidate: { category: "events", abstract: "Second", overview: "", content: "" },
        })),
        JSON.stringify(buildAuditEntry({
          rejected_at: 300,
          candidate: { category: "events", abstract: "Third", overview: "", content: "" },
        })),
      ].join("\n") + "\n",
      "utf8",
    );

    const program = createProgram({
      store: { dbPath },
      retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
      scopeManager: { getStats: () => ({ totalScopes: 1 }) },
      migrator: {},
      admissionControl: {
        rejectedAuditFilePath: auditFile,
      },
    });

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "admission-rejections",
        "--json",
        "--tail",
        "2",
      ]);
    });

    const payload = JSON.parse(output);
    assert.equal(payload.count, 2);
    assert.deepEqual(
      payload.entries.map((entry) => entry.candidate.abstract),
      ["Third", "Second"],
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("memory-pro stats reports admission ratios when audit metadata is enabled", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-admission-stats-"));
  try {
    const now = Date.now();
    const dbPath = path.join(workDir, "db");
    const auditDir = path.join(workDir, "admission-audit");
    const auditFile = path.join(auditDir, "rejections.jsonl");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      auditFile,
      [
        JSON.stringify(buildAuditEntry({ target_scope: "global", rejected_at: now - (2 * 60 * 60 * 1000) })),
        JSON.stringify(buildAuditEntry({ target_scope: "global", rejected_at: now - (3 * 24 * 60 * 60 * 1000) })),
      ].join("\n") + "\n",
      "utf8",
    );

    const program = createProgram({
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
              text: "pref a",
              category: "preference",
              scope: "global",
              importance: 0.8,
              timestamp: now - (3 * 60 * 60 * 1000),
              metadata: JSON.stringify({
                admission_control: { decision: "pass_to_dedup", evaluated_at: now - (3 * 60 * 60 * 1000) },
              }),
            },
            {
              id: "mem-2",
              text: "pref b",
              category: "preference",
              scope: "global",
              importance: 0.8,
              timestamp: now - (8 * 24 * 60 * 60 * 1000),
              metadata: JSON.stringify({
                admission_control: { decision: "pass_to_dedup", evaluated_at: now - (8 * 24 * 60 * 60 * 1000) },
              }),
            },
          ];
        },
      },
      retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
      scopeManager: { getStats: () => ({ totalScopes: 1 }) },
      migrator: {},
      admissionControl: {
        enabled: true,
        auditMetadata: true,
      },
    });

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "stats",
        "--json",
      ]);
    });

    const payload = JSON.parse(output);
    assert.equal(payload.admission.enabled, true);
    assert.equal(payload.admission.admittedCount, 2);
    assert.equal(payload.admission.rejectedCount, 2);
    assert.equal(payload.admission.totalObserved, 4);
    assert.ok(Math.abs(payload.admission.rejectRate - 0.5) < 1e-9);
    assert.equal(payload.admission.topReasons[0].count, 2);
    assert.equal(payload.admission.windows.last24h.admittedCount, 1);
    assert.equal(payload.admission.windows.last24h.rejectedCount, 1);
    assert.equal(payload.admission.windows.last7d.admittedCount, 1);
    assert.equal(payload.admission.windows.last7d.rejectedCount, 2);
    assert.equal(payload.admission.categoryBreakdown.events.admittedCount, 0);
    assert.equal(payload.admission.categoryBreakdown.events.rejectedCount, 2);
    assert.equal(payload.admission.categoryBreakdown.events.totalObserved, 2);
    assert.equal(payload.admission.categoryBreakdown.events.rejectRate, 1);
    assert.equal(payload.admission.categoryBreakdown.preferences.admittedCount, 2);
    assert.equal(payload.admission.categoryBreakdown.preferences.rejectedCount, 0);
    assert.equal(payload.admission.categoryBreakdown.preferences.totalObserved, 2);
    assert.equal(payload.admission.categoryBreakdown.preferences.rejectRate, 0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("memory-pro stats degrades admission summary when audit metadata is disabled", async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "memory-admission-stats-noaudit-"));
  try {
    const dbPath = path.join(workDir, "db");
    const auditDir = path.join(workDir, "admission-audit");
    const auditFile = path.join(auditDir, "rejections.jsonl");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      auditFile,
      JSON.stringify(buildAuditEntry({ target_scope: "global" })) + "\n",
      "utf8",
    );

    const program = createProgram({
      store: {
        dbPath,
        hasFtsSupport: true,
        async stats() {
          return {
            totalCount: 1,
            scopeCounts: { global: 1 },
            categoryCounts: { preference: 1 },
          };
        },
        async list() {
          throw new Error("list should not be called when audit metadata is disabled");
        },
      },
      retriever: { retrieve: async () => [], getConfig: () => ({ mode: "hybrid" }) },
      scopeManager: { getStats: () => ({ totalScopes: 1 }) },
      migrator: {},
      admissionControl: {
        enabled: true,
        auditMetadata: false,
      },
    });

    const output = await captureStdout(async () => {
      await program.parseAsync([
        "node",
        "openclaw",
        "memory-pro",
        "stats",
        "--json",
      ]);
    });

    const payload = JSON.parse(output);
    assert.equal(payload.admission.enabled, true);
    assert.equal(payload.admission.auditMetadataEnabled, false);
    assert.equal(payload.admission.admittedCount, null);
    assert.equal(payload.admission.rejectedCount, 1);
    assert.equal(payload.admission.rejectRate, null);
    assert.equal(payload.admission.categoryBreakdown.events.admittedCount, null);
    assert.equal(payload.admission.categoryBreakdown.events.rejectedCount, 1);
    assert.equal(payload.admission.categoryBreakdown.events.totalObserved, null);
    assert.equal(payload.admission.categoryBreakdown.events.rejectRate, null);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
