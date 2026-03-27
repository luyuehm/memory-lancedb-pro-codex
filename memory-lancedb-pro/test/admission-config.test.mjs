import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";

import jitiFactory from "jiti";

process.env.NODE_PATH = [
  process.env.NODE_PATH,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules",
  "/opt/homebrew/lib/node_modules",
].filter(Boolean).join(":");
Module._initPaths();

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const { parsePluginConfig } = jiti("../index.ts");

function makeBaseConfig(extra = {}) {
  return {
    embedding: {
      provider: "openai-compatible",
      apiKey: "dummy",
      model: "text-embedding-3-small",
      baseURL: "http://127.0.0.1:9/v1",
      dimensions: 1536,
    },
    ...extra,
  };
}

test("parsePluginConfig provides admission control defaults", () => {
  const config = parsePluginConfig(makeBaseConfig());

  assert.equal(config.admissionControl.preset, "balanced");
  assert.equal(config.admissionControl.enabled, false);
  assert.equal(config.admissionControl.utilityMode, "standalone");
  assert.equal(config.admissionControl.rejectThreshold, 0.45);
  assert.equal(config.admissionControl.admitThreshold, 0.6);
  assert.equal(config.admissionControl.noveltyCandidatePoolSize, 8);
  assert.equal(config.admissionControl.recency.halfLifeDays, 14);
  assert.equal(config.admissionControl.auditMetadata, true);
  assert.equal(config.admissionControl.persistRejectedAudits, true);
  assert.equal(config.admissionControl.rejectedAuditFilePath, undefined);
});

test("parsePluginConfig applies admission presets before explicit overrides", () => {
  const config = parsePluginConfig(makeBaseConfig({
    admissionControl: {
      enabled: true,
      preset: "conservative",
      rejectThreshold: 0.5,
      typePriors: {
        events: 0.33,
      },
    },
  }));

  assert.equal(config.admissionControl.preset, "conservative");
  assert.equal(config.admissionControl.enabled, true);
  assert.equal(config.admissionControl.rejectThreshold, 0.5);
  assert.equal(config.admissionControl.admitThreshold, 0.68);
  assert.equal(config.admissionControl.noveltyCandidatePoolSize, 10);
  assert.equal(config.admissionControl.recency.halfLifeDays, 10);
  assert.equal(config.admissionControl.typePriors.events, 0.33);
  assert.equal(config.admissionControl.typePriors.preferences, 0.94);
  assert.ok(Math.abs(config.admissionControl.weights.utility - 0.16) < 1e-9);
  assert.ok(Math.abs(config.admissionControl.weights.typePrior - 0.42) < 1e-9);
});

test("parsePluginConfig normalizes admission weights and thresholds", () => {
  const config = parsePluginConfig(makeBaseConfig({
    admissionControl: {
      enabled: true,
      utilityMode: "off",
      rejectThreshold: 0.7,
      admitThreshold: 0.5,
      noveltyCandidatePoolSize: 12,
      auditMetadata: false,
      persistRejectedAudits: false,
      rejectedAuditFilePath: "./tmp/rejections.jsonl",
      recency: {
        halfLifeDays: 21,
      },
      weights: {
        utility: 2,
        confidence: 1,
        novelty: 1,
        recency: 0,
        typePrior: 2,
      },
      typePriors: {
        events: 0.2,
      },
    },
  }));

  const totalWeight =
    config.admissionControl.weights.utility +
    config.admissionControl.weights.confidence +
    config.admissionControl.weights.novelty +
    config.admissionControl.weights.recency +
    config.admissionControl.weights.typePrior;

  assert.equal(config.admissionControl.enabled, true);
  assert.equal(config.admissionControl.utilityMode, "off");
  assert.equal(config.admissionControl.rejectThreshold, 0.7);
  assert.equal(config.admissionControl.admitThreshold, 0.7);
  assert.equal(config.admissionControl.noveltyCandidatePoolSize, 12);
  assert.equal(config.admissionControl.auditMetadata, false);
  assert.equal(config.admissionControl.persistRejectedAudits, false);
  assert.equal(config.admissionControl.rejectedAuditFilePath, "./tmp/rejections.jsonl");
  assert.equal(config.admissionControl.recency.halfLifeDays, 21);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9);
  assert.equal(config.admissionControl.typePriors.events, 0.2);
});
