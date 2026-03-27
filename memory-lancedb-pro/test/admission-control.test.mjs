import assert from "node:assert/strict";
import test from "node:test";

import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const {
  AdmissionController,
  DEFAULT_ADMISSION_CONTROL_CONFIG,
  scoreConfidenceSupport,
  scoreNoveltyFromMatches,
  scoreTypePrior,
} = jiti("../src/admission-control.ts");

function makeMatch({
  id,
  vector,
  category = "preferences",
  timestamp = Date.now() - 86_400_000,
}) {
  return {
    score: 1,
    entry: {
      id,
      text: `${category}:${id}`,
      vector,
      category: "fact",
      scope: "test",
      importance: 0.8,
      timestamp,
      metadata: JSON.stringify({ memory_category: category }),
    },
  };
}

test("type prior scoring reuses category mapping", () => {
  const defaults = DEFAULT_ADMISSION_CONTROL_CONFIG.typePriors;
  assert.equal(scoreTypePrior("preferences", defaults), 0.9);
  assert.equal(scoreTypePrior("events", {
    ...defaults,
    events: 0.2,
  }), 0.2);
});

test("novelty scoring falls as semantic similarity rises", () => {
  const novelty = scoreNoveltyFromMatches([1, 0], [
    makeMatch({ id: "same", vector: [1, 0] }),
    makeMatch({ id: "orthogonal", vector: [0, 1] }),
  ]);

  assert.equal(novelty.maxSimilarity, 1);
  assert.equal(novelty.score, 0);
  assert.deepEqual(novelty.matchedIds, ["same"]);
  assert.deepEqual(novelty.comparedIds, ["same", "orthogonal"]);
});

test("confidence support rewards grounded candidates and penalizes unsupported detail", () => {
  const candidate = {
    category: "preferences",
    abstract: "Drink preference: oolong tea",
    overview: "User likes oolong tea.",
    content: "The user prefers oolong tea in the evening.",
  };

  const supported = scoreConfidenceSupport(
    candidate,
    "The user says they prefer oolong tea in the evening and usually orders it after work.",
  );
  const unsupported = scoreConfidenceSupport(
    candidate,
    "The user greeted the assistant and asked about calendar sync.",
  );

  assert.ok(supported.score > unsupported.score);
  assert.ok(supported.coverage > unsupported.coverage);
  assert.ok(supported.bestSupport > unsupported.bestSupport);
});

test("admission controller rejects low-value repeated event candidates", async () => {
  const now = Date.now();
  const controller = new AdmissionController(
    {
      async vectorSearch() {
        return [
          makeMatch({
            id: "evt-1",
            category: "events",
            vector: [1, 0],
            timestamp: now,
          }),
        ];
      },
    },
    {
      async completeJson(_prompt, label) {
        assert.equal(label, "admission-utility");
        return { utility: 0.05, reason: "One-off transient update" };
      },
    },
    {
      ...DEFAULT_ADMISSION_CONTROL_CONFIG,
      enabled: true,
    },
  );

  const evaluation = await controller.evaluate({
    candidate: {
      category: "events",
      abstract: "Weather note: it rained today",
      overview: "A one-off weather remark.",
      content: "The user mentioned it rained today.",
    },
    candidateVector: [1, 0],
    conversationText: "The user mentioned it rained today.",
    scopeFilter: ["test"],
    now,
  });

  assert.equal(evaluation.decision, "reject");
  assert.equal(evaluation.hint, undefined);
  assert.equal(evaluation.audit.matched_existing_memory_ids[0], "evt-1");
  assert.ok(evaluation.audit.score < DEFAULT_ADMISSION_CONTROL_CONFIG.rejectThreshold);
});

test("admission controller passes durable preference memories with add hint", async () => {
  const controller = new AdmissionController(
    {
      async vectorSearch() {
        return [];
      },
    },
    {
      async completeJson(_prompt, label) {
        assert.equal(label, "admission-utility");
        return { utility: 0.92, reason: "Durable cross-session preference" };
      },
    },
    {
      ...DEFAULT_ADMISSION_CONTROL_CONFIG,
      enabled: true,
    },
  );

  const evaluation = await controller.evaluate({
    candidate: {
      category: "preferences",
      abstract: "Drink preference: oolong tea",
      overview: "The user consistently prefers oolong tea.",
      content: "The user prefers oolong tea and asks for it across sessions.",
    },
    candidateVector: [0, 1],
    conversationText: "The user says they prefer oolong tea and usually order it.",
    scopeFilter: ["test"],
  });

  assert.equal(evaluation.decision, "pass_to_dedup");
  assert.equal(evaluation.hint, "add");
  assert.ok(
    evaluation.audit.score >= DEFAULT_ADMISSION_CONTROL_CONFIG.admitThreshold,
  );
});
