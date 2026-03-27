import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createCodexMemoryRuntime } from "../dist-codex/runtime/codex/runtime-adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const pluginRoot = path.join(repoRoot, "plugins", "memory-lancedb-pro");
const configPath = path.join(pluginRoot, "config.json");

function uniqueText(tag) {
  return `codex smoke ${tag} ${Date.now()} ${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const skipExtract = process.argv.includes("--basic");
  const cleanupOnly = process.argv.includes("--cleanup-only");
  const scope = "custom:codex-global-smoke";
  const runtime = await createCodexMemoryRuntime({
    configPathCandidates: [configPath],
  });

  const explicitText = uniqueText("explicit-store");
  const extractAnchor = uniqueText("extract-store");
  let explicitId = null;
  let extractedIds = [];

  if (cleanupOnly) {
    const listed = await runtime.listMemories({ scope, limit: 200 });
    const ids = listed.memories.map((memory) => memory.id);
    for (const id of ids) {
      await runtime.forgetMemory({ id, scope });
    }
    console.log(JSON.stringify({
      ok: true,
      mode: "cleanup-only",
      scope,
      deleted: ids.length,
    }, null, 2));
    return;
  }

  try {
    const health = await runtime.health(true);
    assert.equal(health.embeddingConfigured, true, "embedding should be configured");
    assert.equal(health.ftsAvailable, true, "fts should be available");
    assert.equal(health.embedderTest?.success, true, "embedder connectivity should pass");

    const stored = await runtime.storeMemory({
      text: explicitText,
      category: "fact",
      scope,
      importance: 0.77,
      metadata: { source: "codex-memory-smoke" },
    });
    explicitId = stored.id;

    const recall = await runtime.recall({
      query: explicitText,
      limit: 5,
      scope,
    });
    assert.ok(recall.count >= 1, "explicit recall should return at least one row");
    assert.ok(
      recall.memories.some((memory) => memory.id === explicitId),
      "explicitly stored memory should be recalled",
    );

    if (skipExtract) {
      console.log(JSON.stringify({
        ok: true,
        mode: "basic",
        dbPath: health.dbPath,
        scope,
        ftsAvailable: health.ftsAvailable,
        embedderTest: health.embedderTest,
        explicitId,
        explicitRecallCount: recall.count,
      }, null, 2));
      return;
    }

    const beforeExtractList = await runtime.listMemories({ scope, limit: 20 });
    const beforeExtractIds = new Set(beforeExtractList.memories.map((memory) => memory.id));

    const extracted = await runtime.extractAndStoreMemories({
      scope,
      sessionKey: `codex-smoke-${Date.now()}`,
      conversationText: [
        "User: We fixed the cold-start FTS health report by initializing the store before reading hasFtsSupport.",
        `User: Keep this exact regression clue in memory for future debugging context: ${extractAnchor}.`,
        "Assistant: We should remember this fix for the repo because it prevents a false negative health report.",
      ].join("\n"),
    });
    assert.equal(extracted.handled, true, "smart extraction should handle the transcript");
    assert.ok(extracted.created >= 1 || extracted.merged >= 1, "smart extraction should persist or merge memory");

    const listed = await runtime.listMemories({ scope, limit: 20 });
    extractedIds = listed.memories
      .filter((memory) => !beforeExtractIds.has(memory.id))
      .map((memory) => memory.id);
    assert.ok(
      extracted.created === 0 || extractedIds.length >= 1 || extracted.merged >= 1,
      "extraction should create new ids or report a merge",
    );

    const extractedRecall = await runtime.recall({
      query: "cold-start FTS health report",
      limit: 5,
      scope,
    });
    assert.ok(extractedRecall.count >= 1, "extracted memory should be searchable");

    console.log(JSON.stringify({
      ok: true,
      dbPath: health.dbPath,
      scope,
      ftsAvailable: health.ftsAvailable,
      embedderTest: health.embedderTest,
      explicitId,
      explicitRecallCount: recall.count,
      extractedHandled: extracted.handled,
      extractedCreated: extracted.created,
      extractedMerged: extracted.merged,
      extractedIds,
      extractedRecallCount: extractedRecall.count,
      extractedRecallTopText: extractedRecall.memories[0]?.text ?? null,
    }, null, 2));
  } finally {
    const cleanupIds = [explicitId, ...extractedIds].filter(Boolean);
    for (const id of cleanupIds) {
      try {
        await runtime.forgetMemory({ id, scope });
      } catch {
        // Best-effort cleanup for smoke data.
      }
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
