import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();
const require = Module.createRequire(import.meta.url);
const jitiFactory = require("jiti");
const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { parsePluginConfig } = jiti("../index.ts");
const {
  DEFAULT_DREAMING_CONFIG,
  getDreamingScheduleSlot,
  writeDreamingArtifacts,
} = jiti("../src/dreaming.ts");
const {
  buildSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

function makeMemory({
  id,
  text,
  category,
  importance,
  timestamp,
  patch,
}) {
  const metadata = stringifySmartMetadata(
    buildSmartMetadata(
      {
        text,
        category,
        importance,
        timestamp,
      },
      patch,
    ),
  );

  return {
    id,
    text,
    vector: [],
    category,
    scope: "global",
    importance,
    timestamp,
    metadata,
  };
}

test("parsePluginConfig normalizes dreaming defaults and overrides", () => {
  const config = parsePluginConfig({
    embedding: {
      apiKey: "dummy-key",
      model: "text-embedding-3-small",
    },
    dreaming: {
      enabled: true,
      frequency: "15 2 * * *",
      timezone: "Asia/Shanghai",
      storage: {
        mode: "both",
        separateReports: true,
      },
      phases: {
        deep: {
          minScore: 0.72,
          minRecallCount: 3,
        },
      },
    },
  });

  assert.equal(config.dreaming.enabled, true);
  assert.equal(config.dreaming.frequency, "15 2 * * *");
  assert.equal(config.dreaming.timezone, "Asia/Shanghai");
  assert.equal(config.dreaming.storage.mode, "both");
  assert.equal(config.dreaming.storage.separateReports, true);
  assert.equal(config.dreaming.phases.deep.minScore, 0.72);
  assert.equal(config.dreaming.phases.deep.minRecallCount, 3);
  assert.equal(DEFAULT_DREAMING_CONFIG.phases.light.lookbackDays > 0, true);
});

test("getDreamingScheduleSlot respects timezone-aware five-field cron", () => {
  const nowMs = Date.UTC(2026, 3, 9, 19, 0, 0);
  assert.equal(
    getDreamingScheduleSlot(nowMs, "0 3 * * *", "Asia/Shanghai"),
    "2026-04-10T03:00",
  );
  assert.equal(
    getDreamingScheduleSlot(nowMs, "5 3 * * *", "Asia/Shanghai"),
    null,
  );
});

test("writeDreamingArtifacts writes Dreaming-compatible stores and diary", async () => {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "dreaming-compat-"));
  const nowMs = Date.UTC(2026, 3, 9, 20, 0, 0);

  try {
    const memories = [
      makeMemory({
        id: "mem-preference",
        text: "User prefers quiet keyboards late at night",
        category: "preference",
        importance: 0.92,
        timestamp: nowMs - 2 * 60 * 60 * 1000,
        patch: {
          memory_category: "preferences",
          tier: "core",
          confidence: 0.94,
          access_count: 6,
          last_accessed_at: nowMs - 30 * 60 * 1000,
          memory_layer: "durable",
          source: "manual",
        },
      }),
      makeMemory({
        id: "mem-decision",
        text: "Need to make gateway retry behavior more explicit in logs",
        category: "decision",
        importance: 0.78,
        timestamp: nowMs - 4 * 60 * 60 * 1000,
        patch: {
          memory_category: "events",
          tier: "working",
          confidence: 0.82,
          access_count: 2,
          last_accessed_at: nowMs - 45 * 60 * 1000,
          memory_layer: "working",
          source: "auto-capture",
        },
      }),
      makeMemory({
        id: "mem-reflection",
        text: "Reflection suggests making fallback model selection visible to the user",
        category: "reflection",
        importance: 0.74,
        timestamp: nowMs - 90 * 60 * 1000,
        patch: {
          memory_category: "patterns",
          tier: "working",
          confidence: 0.88,
          access_count: 1,
          last_accessed_at: nowMs - 20 * 60 * 1000,
          memory_layer: "reflection",
          source: "reflection",
        },
      }),
    ];

    const result = await writeDreamingArtifacts({
      workspaceDir,
      memories,
      nowMs,
      config: {
        ...DEFAULT_DREAMING_CONFIG,
        enabled: true,
        timezone: "UTC",
        storage: {
          mode: "both",
          separateReports: true,
        },
      },
    });

    const shortTermStore = JSON.parse(readFileSync(result.storePath, "utf8"));
    const phaseSignals = JSON.parse(readFileSync(result.phaseSignalPath, "utf8"));
    const dreams = readFileSync(result.dreamsPath, "utf8");
    const corpusPath = path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-09.md");

    assert.equal(Object.keys(shortTermStore.entries).length >= 2, true);
    assert.equal(
      Object.values(shortTermStore.entries).some((entry) => typeof entry.promotedAt === "string"),
      true,
    );
    assert.equal(Object.keys(phaseSignals.entries).length >= 1, true);
    assert.equal(dreams.includes("<!-- openclaw:dreaming:diary:start -->"), true);
    assert.equal(dreams.includes("memory-lancedb-pro:dreaming-entry day=2026-04-09"), true);
    assert.equal(existsSync(corpusPath), true);
    assert.equal(result.reportPaths.length, 3);
    for (const reportPath of result.reportPaths) {
      assert.equal(existsSync(reportPath), true);
    }
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
