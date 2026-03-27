import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const { registerMemoryUpdateTool } = jiti("../src/tools.ts");
const { MemoryStore } = jiti("../src/store.ts");
const {
  buildSmartMetadata,
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

function createHarness(context) {
  let factory;
  const api = {
    registerTool(toolFactory, meta) {
      if (meta?.name === "memory_update") {
        factory = toolFactory;
      }
    },
  };

  registerMemoryUpdateTool(api, context);

  return {
    tool(toolCtx = {}) {
      assert.ok(factory, "memory_update tool not registered");
      return factory(toolCtx);
    },
  };
}

describe("memory_update supersede", () => {
  it("creates a new active version for temporal categories when text changes", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "memory-update-supersede-"));
    const dbPath = path.join(workDir, "db");
    const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });

    const scopeManager = {
      getAccessibleScopes(agentId) {
        return agentId ? ["global", `agent:${agentId}`] : ["global"];
      },
      isAccessible(scope, agentId) {
        return this.getAccessibleScopes(agentId).includes(scope);
      },
    };

    const context = {
      retriever: {
        async retrieve() {
          return [];
        },
      },
      store,
      scopeManager,
      embedder: {
        async embedPassage() {
          return makeVector(2);
        },
      },
      agentId: "life",
    };

    try {
      const originalText = "饮品偏好：乌龙茶";
      const original = await store.store({
        text: originalText,
        vector: makeVector(1),
        category: "preference",
        scope: "agent:life",
        importance: 0.8,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: originalText, category: "preference", importance: 0.8 },
            {
              l0_abstract: originalText,
              l1_overview: "## Preference\n- 喜欢乌龙茶",
              l2_content: "用户喜欢乌龙茶。",
              memory_category: "preferences",
              tier: "working",
              confidence: 0.8,
              source_session: "agent:life:telegram:direct:old",
            },
          ),
        ),
      });

      const harness = createHarness(context);
      const tool = harness.tool({ agentId: "life", sessionKey: "agent:life:telegram:direct:new" });
      const result = await tool.execute(
        "tc-1",
        { memoryId: original.id, text: "饮品偏好：咖啡" },
        {},
        {},
        { agentId: "life", sessionKey: "agent:life:telegram:direct:new" },
      );

      assert.equal(result.details.action, "superseded");
      assert.equal(result.details.oldId, original.id);
      assert.ok(result.details.newId);

      const oldAfter = await store.getById(original.id, ["agent:life"]);
      const newAfter = await store.getById(result.details.newId, ["agent:life"]);

      assert.ok(oldAfter);
      assert.ok(newAfter);
      assert.equal(oldAfter.text, originalText, "old record text should remain unchanged");
      assert.equal(newAfter.text, "饮品偏好：咖啡");

      const oldMeta = parseSmartMetadata(oldAfter.metadata, oldAfter);
      const newMeta = parseSmartMetadata(newAfter.metadata, newAfter);

      assert.ok(oldMeta.invalidated_at, "old record should be invalidated");
      assert.equal(oldMeta.superseded_by, newAfter.id);
      assert.equal(newMeta.supersedes, oldAfter.id);
      assert.equal(oldMeta.fact_key, newMeta.fact_key);
      assert.equal(isMemoryActiveAt(oldMeta), false);
      assert.equal(isMemoryActiveAt(newMeta), true);
      assert.equal(newMeta.source_session, "agent:life:telegram:direct:new");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps metadata-only updates in-place for temporal categories", async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "memory-update-inplace-"));
    const dbPath = path.join(workDir, "db");
    const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });

    const scopeManager = {
      getAccessibleScopes(agentId) {
        return agentId ? ["global", `agent:${agentId}`] : ["global"];
      },
      isAccessible(scope, agentId) {
        return this.getAccessibleScopes(agentId).includes(scope);
      },
    };

    const context = {
      retriever: {
        async retrieve() {
          return [];
        },
      },
      store,
      scopeManager,
      embedder: {
        async embedPassage() {
          return makeVector(3);
        },
      },
      agentId: "life",
    };

    try {
      const originalText = "编辑器偏好：VS Code";
      const original = await store.store({
        text: originalText,
        vector: makeVector(1),
        category: "preference",
        scope: "agent:life",
        importance: 0.5,
        metadata: stringifySmartMetadata(
          buildSmartMetadata(
            { text: originalText, category: "preference", importance: 0.5 },
            {
              l0_abstract: originalText,
              l1_overview: "## Preference\n- VS Code",
              l2_content: "编辑器偏好：VS Code",
              memory_category: "preferences",
              tier: "working",
              confidence: 0.5,
            },
          ),
        ),
      });

      const harness = createHarness(context);
      const tool = harness.tool({ agentId: "life" });
      const result = await tool.execute(
        "tc-2",
        { memoryId: original.id, importance: 0.9 },
        {},
        {},
        { agentId: "life" },
      );

      assert.equal(result.details.action, "updated");
      assert.equal(result.details.id, original.id);

      const entries = await store.list(["agent:life"], undefined, 10, 0);
      assert.equal(entries.length, 1, "metadata-only update should not create a new version");

      const after = await store.getById(original.id, ["agent:life"]);
      const meta = parseSmartMetadata(after.metadata, after);
      assert.equal(after.importance, 0.9);
      assert.ok(!meta.invalidated_at, "record should stay active");
      assert.equal(isMemoryActiveAt(meta), true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
