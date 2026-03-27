import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { MemoryStore } = jiti("../src/store.ts");
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { createRetriever } = jiti("../src/retriever.ts");
const {
  buildSmartMetadata,
  deriveFactKey,
  isMemoryActiveAt,
  parseSmartMetadata,
  stringifySmartMetadata,
} = jiti("../src/smart-metadata.ts");

const VECTOR_DIM = 8;

function makeVector(seed = 1) {
  const vector = new Array(VECTOR_DIM).fill(1 / Math.sqrt(VECTOR_DIM));
  vector[0] = seed * 0.1;
  return vector;
}

describe("temporal facts", () => {
  it("derives stable fact keys from mutable preference topics", () => {
    assert.equal(
      deriveFactKey("preferences", "饮品偏好：乌龙茶"),
      "preferences:饮品偏好",
    );
    assert.equal(
      deriveFactKey("entities", "Project status: paused"),
      "entities:project status",
    );
    assert.equal(deriveFactKey("cases", "问题 -> 方案"), undefined);
  });

  it("keeps historical preference versions but retrieves only the active one", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "temporal-facts-"));
    const dbPath = path.join(workDir, "db");
    const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });

    const embedder = {
      async embed() {
        return makeVector(1);
      },
      async embedQuery() {
        return makeVector(1);
      },
    };

    const llm = {
      async completeJson(prompt) {
        if (prompt.includes("Analyze the following session context")) {
          return {
            memories: [{
              category: "preferences",
              abstract: "饮品偏好：咖啡",
              overview: "## Preference\n- 现在偏好咖啡",
              content: "用户现在改喝咖啡。",
            }],
          };
        }

        if (prompt.includes("Determine how to handle this candidate memory")) {
          return {
            decision: "supersede",
            match_index: 1,
            reason: "same preference topic, new truth replaces old truth",
          };
        }

        throw new Error(`Unexpected prompt: ${prompt.slice(0, 80)}`);
      },
    };

    try {
      const oldText = "饮品偏好：乌龙茶";
      const oldEntry = await store.store({
        text: oldText,
        vector: makeVector(1),
        category: "preference",
        scope: "test",
        importance: 0.8,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: oldText, category: "preference", importance: 0.8 },
            {
              l0_abstract: oldText,
              l1_overview: "## Preference\n- 喜欢乌龙茶",
              l2_content: "用户喜欢乌龙茶。",
              memory_category: "preferences",
              tier: "working",
              confidence: 0.8,
            },
          ),
        ),
      });

      const extractor = new SmartExtractor(store, embedder, llm, {
        user: "User",
        extractMinMessages: 1,
        defaultScope: "test",
      });

      const stats = await extractor.extractAndPersist(
        "用户现在改喝咖啡。",
        "temporal-session",
        { scope: "test", scopeFilter: ["test"] },
      );

      assert.equal(stats.created, 1);
      assert.equal(stats.superseded, 1);

      const entries = await store.list(["test"], undefined, 10, 0);
      assert.equal(entries.length, 2, "supersede should keep old + new records");

      const currentEntry = entries.find((entry) => entry.text.includes("咖啡"));
      const historicalEntry = entries.find((entry) => entry.id === oldEntry.id);

      assert.ok(currentEntry, "new current entry should exist");
      assert.ok(historicalEntry, "historical entry should still exist");

      const currentMeta = parseSmartMetadata(currentEntry.metadata, currentEntry);
      const historicalMeta = parseSmartMetadata(historicalEntry.metadata, historicalEntry);

      assert.equal(currentMeta.supersedes, historicalEntry.id);
      assert.equal(historicalMeta.superseded_by, currentEntry.id);
      assert.ok(historicalMeta.invalidated_at, "historical entry should be invalidated");
      assert.equal(currentMeta.fact_key, historicalMeta.fact_key);
      assert.equal(isMemoryActiveAt(currentMeta), true);
      assert.equal(isMemoryActiveAt(historicalMeta), false);

      const activeMatches = await store.vectorSearch(
        makeVector(1),
        5,
        0.1,
        ["test"],
        { excludeInactive: true },
      );
      assert.equal(activeMatches.length, 1, "excludeInactive should hide superseded history");
      assert.equal(activeMatches[0].entry.id, currentEntry.id);

      const retriever = createRetriever(store, embedder, {
        mode: "vector",
        rerank: "none",
        minScore: 0.1,
        hardMinScore: 0,
        filterNoise: false,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        lengthNormAnchor: 0,
        timeDecayHalfLifeDays: 0,
        reinforcementFactor: 0,
        maxHalfLifeMultiplier: 1,
      });

      const results = await retriever.retrieve({
        query: "饮品偏好",
        limit: 5,
        scopeFilter: ["test"],
        source: "cli",
      });

      assert.equal(results.length, 1, "retrieval should hide invalidated facts");
      assert.equal(results[0].entry.id, currentEntry.id);
      assert.match(results[0].entry.text, /咖啡/);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
