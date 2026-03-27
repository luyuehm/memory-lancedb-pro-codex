import assert from "node:assert/strict";
import test from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { SmartExtractor } = jiti("../src/smart-extractor.ts");
const { DEFAULT_ADMISSION_CONTROL_CONFIG } = jiti("../src/admission-control.ts");
const { buildSmartMetadata, stringifySmartMetadata } = jiti("../src/smart-metadata.ts");

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

class FakeStore {
  constructor(seedEntries = []) {
    this.entries = new Map(seedEntries.map((entry) => [entry.id, { ...entry }]));
    this.nextId = seedEntries.length + 1;
  }

  async vectorSearch(vector, limit, threshold, scopeFilter = []) {
    return Array.from(this.entries.values())
      .filter((entry) => scopeFilter.length === 0 || scopeFilter.includes(entry.scope))
      .map((entry) => ({
        score: cosineSimilarity(vector, entry.vector || []),
        entry: { ...entry },
      }))
      .filter((match) => match.score >= threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async getById(id, scopeFilter = []) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (scopeFilter.length > 0 && !scopeFilter.includes(entry.scope)) return null;
    return { ...entry };
  }

  async store(payload) {
    const id = `mem-${this.nextId++}`;
    this.entries.set(id, {
      id,
      text: payload.text,
      vector: payload.vector,
      category: payload.category,
      scope: payload.scope,
      importance: payload.importance,
      metadata: payload.metadata,
      timestamp: Date.now(),
    });
  }

  async update(id, patch) {
    const current = this.entries.get(id);
    if (!current) return;
    this.entries.set(id, {
      ...current,
      ...patch,
    });
  }
}

function makeSeedPreference() {
  const text = "Drink preference: oolong tea";
  return {
    id: "pref-1",
    text,
    vector: [0, 1, 0],
    category: "preference",
    scope: "test",
    importance: 0.8,
    timestamp: Date.now() - 7 * 86_400_000,
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text, category: "preference", importance: 0.8 },
        {
          l0_abstract: text,
          l1_overview: "The user consistently prefers oolong tea.",
          l2_content: "The user prefers oolong tea across conversations.",
          memory_category: "preferences",
          tier: "working",
          confidence: 0.8,
        },
      ),
    ),
  };
}

function createEmbedder() {
  return {
    async embed(text) {
      const value = String(text).toLowerCase();
      if (value.includes("oolong") || value.includes("jasmine") || value.includes("tea")) {
        return [0, 1, 0];
      }
      if (value.includes("weather") || value.includes("rain")) {
        return [1, 0, 0];
      }
      return [0, 0, 1];
    },
  };
}

test("admission reject blocks persistence before downstream dedup", async () => {
  const seedEvent = {
    id: "evt-1",
    text: "Weather note: it rained today",
    vector: [1, 0, 0],
    category: "decision",
    scope: "test",
    importance: 0.4,
    timestamp: Date.now(),
    metadata: stringifySmartMetadata(
      buildSmartMetadata(
        { text: "Weather note: it rained today", category: "decision", importance: 0.4 },
        {
          l0_abstract: "Weather note: it rained today",
          l1_overview: "A transient weather update.",
          l2_content: "The user mentioned it rained today.",
          memory_category: "events",
          tier: "working",
          confidence: 0.6,
        },
      ),
    ),
  };
  const store = new FakeStore([seedEvent]);
  const llmLabels = [];
  const rejectedAudits = [];
  const extractor = new SmartExtractor(
    store,
    createEmbedder(),
    {
      async completeJson(_prompt, label) {
        llmLabels.push(label);
        if (label === "extract-candidates") {
          return {
            memories: [{
              category: "events",
              abstract: "Weather note: it rained today",
              overview: "A transient weather update.",
              content: "The user mentioned it rained today.",
            }],
          };
        }
        if (label === "admission-utility") {
          return { utility: 0.05, reason: "One-off transient update" };
        }
        throw new Error(`unexpected label: ${label}`);
      },
    },
    {
      defaultScope: "test",
      admissionControl: {
        ...DEFAULT_ADMISSION_CONTROL_CONFIG,
        enabled: true,
      },
      onAdmissionRejected: async (entry) => {
        rejectedAudits.push(entry);
      },
    },
  );

  const stats = await extractor.extractAndPersist(
    "The user mentioned it rained today.",
    "session-1",
    { scope: "test", scopeFilter: ["test"] },
  );

  assert.equal(stats.rejected, 1);
  assert.equal(store.entries.size, 1);
  assert.deepEqual(llmLabels, ["extract-candidates", "admission-utility"]);
  assert.equal(rejectedAudits.length, 1);
  assert.equal(rejectedAudits[0].audit.decision, "reject");
  assert.equal(rejectedAudits[0].audit.hint, undefined);
  assert.equal(rejectedAudits[0].target_scope, "test");
  assert.equal(rejectedAudits[0].candidate.category, "events");
  assert.match(rejectedAudits[0].conversation_excerpt, /rained today/i);
});

test("admission pass still flows into downstream merge behavior", async () => {
  const store = new FakeStore([makeSeedPreference()]);
  const llmLabels = [];
  const extractor = new SmartExtractor(
    store,
    createEmbedder(),
    {
      async completeJson(_prompt, label) {
        llmLabels.push(label);
        if (label === "extract-candidates") {
          return {
            memories: [{
              category: "preferences",
              abstract: "Drink preference: oolong tea and jasmine tea",
              overview: "The user likes oolong tea and also jasmine tea.",
              content: "The user prefers oolong tea and recently added jasmine tea.",
            }],
          };
        }
        if (label === "admission-utility") {
          return { utility: 0.92, reason: "Durable cross-session preference" };
        }
        if (label === "dedup-decision") {
          return {
            decision: "merge",
            match_index: 1,
            reason: "Same preference domain, merge into the existing preference memory.",
          };
        }
        if (label === "merge-memory") {
          return {
            abstract: "Drink preference: oolong tea and jasmine tea",
            overview: "The user likes oolong tea and jasmine tea.",
            content: "The user prefers oolong tea and has recently added jasmine tea.",
          };
        }
        throw new Error(`unexpected label: ${label}`);
      },
    },
    {
      defaultScope: "test",
      admissionControl: {
        ...DEFAULT_ADMISSION_CONTROL_CONFIG,
        enabled: true,
      },
    },
  );

  const stats = await extractor.extractAndPersist(
    "The user prefers oolong tea and recently added jasmine tea.",
    "session-2",
    { scope: "test", scopeFilter: ["test"] },
  );

  assert.equal(stats.merged, 1);
  assert.equal(store.entries.size, 1);
  assert.deepEqual(llmLabels, [
    "extract-candidates",
    "admission-utility",
    "dedup-decision",
    "merge-memory",
  ]);

  const mergedEntry = store.entries.get("pref-1");
  assert.equal(mergedEntry.text, "Drink preference: oolong tea and jasmine tea");

  const metadata = JSON.parse(mergedEntry.metadata);
  assert.equal(metadata.admission_control.decision, "pass_to_dedup");
  assert.equal(metadata.admission_control.hint, "update_or_merge");
  assert.equal(metadata.memory_category, "preferences");
  assert.equal(metadata.confidence, 0.8);
});

test("stored memory confidence stays at lifecycle default while admission audit keeps feature confidence", async () => {
  const store = new FakeStore();
  const extractor = new SmartExtractor(
    store,
    createEmbedder(),
    {
      async completeJson(_prompt, label) {
        if (label === "extract-candidates") {
          return {
            memories: [{
              category: "preferences",
              abstract: "Drink preference: jasmine tea",
              overview: "The user prefers jasmine tea.",
              content: "The user prefers jasmine tea across sessions.",
            }],
          };
        }
        if (label === "admission-utility") {
          return { utility: 0.9, reason: "Durable cross-session preference" };
        }
        throw new Error(`unexpected label: ${label}`);
      },
    },
    {
      defaultScope: "test",
      admissionControl: {
        ...DEFAULT_ADMISSION_CONTROL_CONFIG,
        enabled: true,
      },
    },
  );

  const stats = await extractor.extractAndPersist(
    "The user prefers jasmine tea across sessions.",
    "session-3a",
    { scope: "test", scopeFilter: ["test"] },
  );

  assert.equal(stats.created, 1);
  assert.equal(store.entries.size, 1);

  const createdEntry = Array.from(store.entries.values())[0];
  const metadata = JSON.parse(createdEntry.metadata);
  assert.equal(metadata.memory_category, "preferences");
  assert.equal(metadata.confidence, 0.7);
  assert.ok(metadata.admission_control.feature_scores.confidence > 0.7);
});

test("auditMetadata false omits admission audit from stored metadata", async () => {
  const store = new FakeStore();
  const extractor = new SmartExtractor(
    store,
    createEmbedder(),
    {
      async completeJson(_prompt, label) {
        if (label === "extract-candidates") {
          return {
            memories: [{
              category: "preferences",
              abstract: "Drink preference: jasmine tea",
              overview: "The user prefers jasmine tea.",
              content: "The user prefers jasmine tea across sessions.",
            }],
          };
        }
        if (label === "admission-utility") {
          return { utility: 0.9, reason: "Durable cross-session preference" };
        }
        throw new Error(`unexpected label: ${label}`);
      },
    },
    {
      defaultScope: "test",
      admissionControl: {
        ...DEFAULT_ADMISSION_CONTROL_CONFIG,
        enabled: true,
        auditMetadata: false,
      },
    },
  );

  const stats = await extractor.extractAndPersist(
    "The user prefers jasmine tea across sessions.",
    "session-3",
    { scope: "test", scopeFilter: ["test"] },
  );

  assert.equal(stats.created, 1);
  assert.equal(store.entries.size, 1);

  const createdEntry = Array.from(store.entries.values())[0];
  const metadata = JSON.parse(createdEntry.metadata);
  assert.equal(metadata.memory_category, "preferences");
  assert.equal(metadata.admission_control, undefined);
});
