import path from "node:path";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { MemoryEntry } from "./store.js";
import {
  isMemoryActiveAt,
  parseSmartMetadata,
  type SmartMemoryMetadata,
} from "./smart-metadata.js";

export type DreamingStorageMode = "inline" | "separate" | "both";

export interface DreamingLightConfig {
  enabled: boolean;
  lookbackDays: number;
  limit: number;
}

export interface DreamingDeepConfig {
  enabled: boolean;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
}

export interface DreamingRemConfig {
  enabled: boolean;
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
}

export interface DreamingConfig {
  enabled: boolean;
  frequency: string;
  timezone?: string;
  verboseLogging: boolean;
  storage: {
    mode: DreamingStorageMode;
    separateReports: boolean;
  };
  phases: {
    light: DreamingLightConfig;
    deep: DreamingDeepConfig;
    rem: DreamingRemConfig;
  };
}

export interface DreamingWriteResult {
  workspaceDir: string;
  dreamsPath: string;
  storePath: string;
  phaseSignalPath: string;
  shortTermCount: number;
  promotedCount: number;
  lightSignalCount: number;
  remSignalCount: number;
  reportPaths: string[];
}

interface DreamingCandidate {
  entry: MemoryEntry;
  metadata: SmartMemoryMetadata;
  isoDay: string;
  snippet: string;
  score: number;
  ageDays: number;
  accessCount: number;
  lastAccessedAt: number;
  promoted: boolean;
}

interface CorpusLineRef {
  path: string;
  startLine: number;
  endLine: number;
}

interface DreamingShortTermEntry {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt?: string;
  lastRecalledAt?: string;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  promotedAt?: string;
}

const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"];
const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
const PLUGIN_ENTRY_MARKER_PREFIX = "memory-lancedb-pro:dreaming-entry day=";
const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const PHASE_SIGNAL_RELATIVE_PATH = path.join("memory", ".dreams", "phase-signals.json");
const DREAMING_EVENTS_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const DREAMING_REPORT_RELATIVE_DIR = path.join("memory", "dreaming");
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_FREQUENCY = "0 3 * * *";

export const DEFAULT_DREAMING_CONFIG: DreamingConfig = {
  enabled: false,
  frequency: DEFAULT_FREQUENCY,
  timezone: undefined,
  verboseLogging: false,
  storage: {
    mode: "inline",
    separateReports: false,
  },
  phases: {
    light: {
      enabled: true,
      lookbackDays: 7,
      limit: 12,
    },
    deep: {
      enabled: true,
      limit: 8,
      minScore: 0.6,
      minRecallCount: 2,
      minUniqueQueries: 1,
      recencyHalfLifeDays: 14,
      maxAgeDays: 30,
    },
    rem: {
      enabled: true,
      lookbackDays: 14,
      limit: 8,
      minPatternStrength: 0.45,
    },
  },
};

function clampInt(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampNumber(value: unknown, fallback: number, min = 0, max = 1): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function resolveStorageMode(value: unknown): DreamingStorageMode {
  return value === "inline" || value === "separate" || value === "both"
    ? value
    : DEFAULT_DREAMING_CONFIG.storage.mode;
}

export function parseDreamingConfig(value: unknown): DreamingConfig {
  const raw = asRecord(value);
  const storageRaw = asRecord(raw?.storage);
  const phasesRaw = asRecord(raw?.phases);
  const lightRaw = asRecord(phasesRaw?.light);
  const deepRaw = asRecord(phasesRaw?.deep);
  const remRaw = asRecord(phasesRaw?.rem);

  return {
    enabled: raw?.enabled === true,
    frequency: asOptionalString(raw?.frequency) ?? DEFAULT_FREQUENCY,
    timezone: asOptionalString(raw?.timezone),
    verboseLogging: raw?.verboseLogging === true,
    storage: {
      mode: resolveStorageMode(storageRaw?.mode),
      separateReports: storageRaw?.separateReports === true,
    },
    phases: {
      light: {
        enabled: lightRaw?.enabled !== false,
        lookbackDays: clampInt(
          lightRaw?.lookbackDays,
          DEFAULT_DREAMING_CONFIG.phases.light.lookbackDays,
          0,
          365,
        ),
        limit: clampInt(
          lightRaw?.limit,
          DEFAULT_DREAMING_CONFIG.phases.light.limit,
          0,
          100,
        ),
      },
      deep: {
        enabled: deepRaw?.enabled !== false,
        limit: clampInt(
          deepRaw?.limit,
          DEFAULT_DREAMING_CONFIG.phases.deep.limit,
          0,
          100,
        ),
        minScore: clampNumber(
          deepRaw?.minScore,
          DEFAULT_DREAMING_CONFIG.phases.deep.minScore,
          0,
          1,
        ),
        minRecallCount: clampInt(
          deepRaw?.minRecallCount,
          DEFAULT_DREAMING_CONFIG.phases.deep.minRecallCount,
          0,
          1000,
        ),
        minUniqueQueries: clampInt(
          deepRaw?.minUniqueQueries,
          DEFAULT_DREAMING_CONFIG.phases.deep.minUniqueQueries,
          0,
          1000,
        ),
        recencyHalfLifeDays: clampInt(
          deepRaw?.recencyHalfLifeDays,
          DEFAULT_DREAMING_CONFIG.phases.deep.recencyHalfLifeDays,
          0,
          365,
        ),
        maxAgeDays: deepRaw?.maxAgeDays === undefined
          ? DEFAULT_DREAMING_CONFIG.phases.deep.maxAgeDays
          : clampInt(deepRaw.maxAgeDays, DEFAULT_DREAMING_CONFIG.phases.deep.maxAgeDays ?? 30, 1, 3650),
      },
      rem: {
        enabled: remRaw?.enabled !== false,
        lookbackDays: clampInt(
          remRaw?.lookbackDays,
          DEFAULT_DREAMING_CONFIG.phases.rem.lookbackDays,
          0,
          365,
        ),
        limit: clampInt(
          remRaw?.limit,
          DEFAULT_DREAMING_CONFIG.phases.rem.limit,
          0,
          100,
        ),
        minPatternStrength: clampNumber(
          remRaw?.minPatternStrength,
          DEFAULT_DREAMING_CONFIG.phases.rem.minPatternStrength,
          0,
          1,
        ),
      },
    },
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

function resolveTimeZone(timezone?: string): string | undefined {
  if (!timezone) return undefined;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return undefined;
  }
}

function getZonedDateParts(epochMs: number, timezone?: string): ZonedDateParts {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    format.formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

function toIsoDay(epochMs: number, timezone?: string): string {
  const parts = getZonedDateParts(epochMs, timezone);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function toIsoMinuteKey(epochMs: number, timezone?: string): string {
  const parts = getZonedDateParts(epochMs, timezone);
  return `${toIsoDay(epochMs, timezone)}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function parseCronField(
  rawField: string,
  min: number,
  max: number,
  options?: { normalizeSunday?: boolean },
): Set<number> | null | undefined {
  const field = rawField.trim();
  if (field === "*" || field.length === 0) return null;

  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;

    const [base, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : clampInt(stepRaw, 0, 1, 10_000);
    if (step <= 0) return null;

    let rangeStart: number;
    let rangeEnd: number;

    if (base === "*") {
      rangeStart = min;
      rangeEnd = max;
    } else if (/^\d+$/.test(base)) {
      rangeStart = Number(base);
      rangeEnd = Number(base);
    } else {
      const match = /^(\d+)-(\d+)$/.exec(base);
      if (!match) return null;
      rangeStart = Number(match[1]);
      rangeEnd = Number(match[2]);
    }

    if (options?.normalizeSunday) {
      if (rangeStart === 7) rangeStart = 0;
      if (rangeEnd === 7) rangeEnd = 0;
    }

    if (rangeStart < min || rangeStart > max || rangeEnd < min || rangeEnd > max) {
      return null;
    }

    if (rangeEnd < rangeStart) {
      for (let value = rangeStart; value <= max; value += step) {
        values.add(options?.normalizeSunday && value === 7 ? 0 : value);
      }
      for (let value = min; value <= rangeEnd; value += step) {
        values.add(options?.normalizeSunday && value === 7 ? 0 : value);
      }
      continue;
    }

    for (let value = rangeStart; value <= rangeEnd; value += step) {
      values.add(options?.normalizeSunday && value === 7 ? 0 : value);
    }
  }

  return values;
}

export function getDreamingScheduleSlot(
  nowMs: number,
  frequency: string,
  timezone?: string,
): string | null {
  const trimmed = frequency.trim();
  if (!trimmed) return null;

  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;

  const minute = parseCronField(fields[0], 0, 59);
  const hour = parseCronField(fields[1], 0, 23);
  const dayOfMonth = parseCronField(fields[2], 1, 31);
  const month = parseCronField(fields[3], 1, 12);
  const dayOfWeek = parseCronField(fields[4], 0, 7, { normalizeSunday: true });
  if (minute === undefined || hour === undefined || dayOfMonth === undefined || month === undefined || dayOfWeek === undefined) {
    return null;
  }

  const parts = getZonedDateParts(nowMs, timezone);
  if (minute && !minute.has(parts.minute)) return null;
  if (hour && !hour.has(parts.hour)) return null;
  if (month && !month.has(parts.month)) return null;

  const domMatch = dayOfMonth ? dayOfMonth.has(parts.day) : true;
  const dowMatch = dayOfWeek ? dayOfWeek.has(parts.weekday) : true;
  if (dayOfMonth && dayOfWeek) {
    if (!domMatch && !dowMatch) return null;
  } else {
    if (!domMatch || !dowMatch) return null;
  }

  return toIsoMinuteKey(nowMs, timezone);
}

function toIsoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toSnippet(entry: MemoryEntry, metadata: SmartMemoryMetadata): string {
  const preferred = [
    metadata.l0_abstract,
    metadata.l1_overview,
    entry.text,
  ].find((value) => typeof value === "string" && normalizeWhitespace(value).length > 0) ?? "";

  return normalizeWhitespace(preferred)
    .replace(/^[-*]\s+/, "")
    .slice(0, 240);
}

function buildCandidate(
  entry: MemoryEntry,
  nowMs: number,
  config: DreamingConfig,
): DreamingCandidate | null {
  const metadata = parseSmartMetadata(entry.metadata, entry);
  if (!isMemoryActiveAt(metadata, nowMs)) return null;
  if (metadata.state === "archived") return null;
  if (metadata.type === "session-summary") return null;

  const snippet = toSnippet(entry, metadata);
  if (!snippet) return null;

  const createdAt = Number.isFinite(entry.timestamp) ? entry.timestamp : nowMs;
  const ageDays = Math.max(0, (nowMs - createdAt) / MS_PER_DAY);
  const maxAgeDays = config.phases.deep.maxAgeDays ?? 60;
  if (ageDays > Math.max(maxAgeDays, config.phases.rem.lookbackDays, config.phases.light.lookbackDays) * 2) {
    return null;
  }

  const accessCount = clampInt(metadata.access_count, 0, 0, 10_000);
  const lastAccessedAt = clampInt(metadata.last_accessed_at, createdAt, 0, Number.MAX_SAFE_INTEGER);
  const recencyHalfLife = Math.max(1, config.phases.deep.recencyHalfLifeDays);
  const recencyScore = Math.exp(-ageDays * (Math.LN2 / recencyHalfLife));
  const accessScore = Math.min(1, accessCount / Math.max(2, config.phases.deep.minRecallCount + 2));
  const importanceScore = clampNumber(entry.importance, 0.5, 0, 1);
  const confidenceScore = clampNumber(metadata.confidence, 0.65, 0, 1);
  const reflectionBoost = metadata.source === "reflection" || entry.category === "reflection" ? 0.08 : 0;
  const score = Math.min(
    1,
    importanceScore * 0.36 +
      confidenceScore * 0.24 +
      accessScore * 0.2 +
      recencyScore * 0.2 +
      reflectionBoost,
  );

  const promoted =
    config.phases.deep.enabled &&
    score >= config.phases.deep.minScore &&
    accessCount >= config.phases.deep.minRecallCount &&
    (metadata.tier === "core" ||
      metadata.memory_layer === "durable" ||
      importanceScore >= 0.78 ||
      accessCount >= config.phases.deep.minRecallCount + 2) &&
    (config.phases.deep.maxAgeDays === undefined || ageDays <= config.phases.deep.maxAgeDays);

  return {
    entry,
    metadata,
    isoDay: toIsoDay(createdAt, config.timezone),
    snippet,
    score,
    ageDays,
    accessCount,
    lastAccessedAt,
    promoted,
  };
}

function compareCandidatesByRecency(a: DreamingCandidate, b: DreamingCandidate): number {
  if (b.entry.timestamp !== a.entry.timestamp) return b.entry.timestamp - a.entry.timestamp;
  if (b.score !== a.score) return b.score - a.score;
  return a.entry.id.localeCompare(b.entry.id);
}

function compareCandidatesByScore(a: DreamingCandidate, b: DreamingCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.accessCount !== a.accessCount) return b.accessCount - a.accessCount;
  return compareCandidatesByRecency(a, b);
}

function buildCorpusLine(candidate: DreamingCandidate): string {
  const tags = [
    candidate.metadata.tier,
    candidate.metadata.memory_category,
    candidate.entry.scope,
  ].filter(Boolean).join("/");
  return `- [${tags}] ${candidate.snippet}`;
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, { encoding: "utf-8", flag: "wx" });
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function resolveDreamsPath(workspaceDir: string): Promise<string> {
  for (const name of DREAMS_FILENAMES) {
    const candidate = path.join(workspaceDir, name);
    try {
      await readFile(candidate, "utf-8");
      return candidate;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return path.join(workspaceDir, DREAMS_FILENAMES[0]);
}

function ensureDiarySection(content: string): string {
  if (content.includes(DIARY_START_MARKER) && content.includes(DIARY_END_MARKER)) {
    return content;
  }
  const section = `# Dream Diary\n\n${DIARY_START_MARKER}\n${DIARY_END_MARKER}\n`;
  return content.trim().length === 0 ? section : `${section}\n${content}`;
}

function splitDiaryBlocks(content: string): string[] {
  return content
    .split(/\n---\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function joinDiaryBlocks(blocks: string[]): string {
  return blocks.length === 0
    ? ""
    : blocks.map((block) => `---\n\n${block.trim()}\n`).join("\n");
}

function replaceDiaryBlocks(existing: string, blocks: string[]): string {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return ensured;
  const before = ensured.slice(0, startIdx + DIARY_START_MARKER.length);
  const after = ensured.slice(endIdx);
  const body = joinDiaryBlocks(blocks);
  return `${before}${body ? `\n${body}` : "\n"}${after}`;
}

function formatNarrativeDate(epochMs: number, timezone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timezone),
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(epochMs));
}

function formatEntryList(candidates: DreamingCandidate[], limit: number): string[] {
  return candidates.slice(0, limit).map((candidate) => candidate.snippet);
}

function buildDiaryNarrative(params: {
  nowMs: number;
  config: DreamingConfig;
  active: DreamingCandidate[];
  promoted: DreamingCandidate[];
}): string | null {
  const snippets = formatEntryList(params.active, 3);
  const promotedSnippets = formatEntryList(params.promoted, 2);
  if (snippets.length === 0 && promotedSnippets.length === 0) return null;

  const pieces: string[] = [];
  if (snippets.length > 0) {
    pieces.push(`Today the memory stream kept circling around ${snippets.map((snippet) => `"${snippet}"`).join(", ")}.`);
  }
  if (promotedSnippets.length > 0) {
    pieces.push(`A few patterns felt settled enough to keep: ${promotedSnippets.map((snippet) => `"${snippet}"`).join(", ")}.`);
  }

  const reflectionCount = params.active.filter((candidate) =>
    candidate.metadata.source === "reflection" || candidate.entry.category === "reflection"
  ).length;
  if (reflectionCount > 0) {
    pieces.push("The reflections carried more weight than raw logs, which makes this diary feel a little more like a stitched-together memory than a dump of traces.");
  } else {
    pieces.push("The threads are still concrete and close to the surface, but they already hint at what wants to stick.");
  }

  return pieces.join(" ");
}

function buildDiaryBlock(isoDay: string, dateLabel: string, narrative: string): string {
  return [
    `*${dateLabel}*`,
    `<!-- ${PLUGIN_ENTRY_MARKER_PREFIX}${isoDay} -->`,
    narrative.trim(),
  ].join("\n\n");
}

async function writeDreamDiary(params: {
  workspaceDir: string;
  nowMs: number;
  config: DreamingConfig;
  active: DreamingCandidate[];
  promoted: DreamingCandidate[];
}): Promise<string> {
  const dreamsPath = await resolveDreamsPath(params.workspaceDir);
  let existing = "";
  try {
    existing = await readFile(dreamsPath, "utf-8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  const currentDiary = startIdx >= 0 && endIdx > startIdx
    ? ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx)
    : "";
  const isoDay = toIsoDay(params.nowMs, params.config.timezone);
  const keptBlocks = splitDiaryBlocks(currentDiary).filter((block) =>
    !block.includes(`${PLUGIN_ENTRY_MARKER_PREFIX}${isoDay}`)
  );
  const narrative = buildDiaryNarrative(params);
  if (narrative) {
    keptBlocks.push(
      buildDiaryBlock(
        isoDay,
        formatNarrativeDate(params.nowMs, params.config.timezone),
        narrative,
      ),
    );
  }

  const nextContent = replaceDiaryBlocks(ensured, keptBlocks);
  await writeFileAtomic(dreamsPath, nextContent.endsWith("\n") ? nextContent : `${nextContent}\n`);
  return dreamsPath;
}

function buildPhaseReport(title: string, isoDay: string, lines: string[]): string {
  return [
    `# ${title}`,
    "",
    `Date: ${isoDay}`,
    "",
    ...(lines.length > 0 ? lines : ["No entries qualified for this phase during the latest dreaming sweep."]),
    "",
  ].join("\n");
}

function shouldWritePhaseReports(config: DreamingConfig): boolean {
  return config.storage.mode === "separate"
    || config.storage.mode === "both"
    || config.storage.separateReports;
}

async function writePhaseReports(params: {
  workspaceDir: string;
  isoDay: string;
  config: DreamingConfig;
  active: DreamingCandidate[];
  promoted: DreamingCandidate[];
}): Promise<string[]> {
  if (!shouldWritePhaseReports(params.config)) return [];

  const baseDir = path.join(params.workspaceDir, DREAMING_REPORT_RELATIVE_DIR);
  const reportPaths: string[] = [];

  const lightLines = params.active
    .filter((candidate) => candidate.ageDays <= params.config.phases.light.lookbackDays)
    .sort(compareCandidatesByRecency)
    .slice(0, params.config.phases.light.limit)
    .map((candidate) => `- ${candidate.snippet} (score=${candidate.score.toFixed(2)}, recalls=${candidate.accessCount})`);
  const lightPath = path.join(baseDir, "light", `${params.isoDay}.md`);
  await writeFileAtomic(lightPath, buildPhaseReport("Light Dreaming Report", params.isoDay, lightLines));
  reportPaths.push(lightPath);

  const remLines = params.active
    .filter((candidate) =>
      candidate.ageDays <= params.config.phases.rem.lookbackDays &&
      (candidate.score >= params.config.phases.rem.minPatternStrength ||
        candidate.metadata.source === "reflection" ||
        candidate.entry.category === "reflection")
    )
    .sort(compareCandidatesByScore)
    .slice(0, params.config.phases.rem.limit)
    .map((candidate) => `- ${candidate.snippet} (pattern=${candidate.score.toFixed(2)}, source=${candidate.metadata.source})`);
  const remPath = path.join(baseDir, "rem", `${params.isoDay}.md`);
  await writeFileAtomic(remPath, buildPhaseReport("REM Dreaming Report", params.isoDay, remLines));
  reportPaths.push(remPath);

  const deepLines = params.promoted
    .sort(compareCandidatesByScore)
    .slice(0, params.config.phases.deep.limit)
    .map((candidate) => `- ${candidate.snippet} (promoted, recalls=${candidate.accessCount}, tier=${candidate.metadata.tier})`);
  const deepPath = path.join(baseDir, "deep", `${params.isoDay}.md`);
  await writeFileAtomic(deepPath, buildPhaseReport("Deep Dreaming Report", params.isoDay, deepLines));
  reportPaths.push(deepPath);

  return reportPaths;
}

async function writeSessionCorpusFiles(params: {
  workspaceDir: string;
  candidates: DreamingCandidate[];
}): Promise<Map<string, CorpusLineRef>> {
  const corpusRoot = path.join(params.workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const grouped = new Map<string, DreamingCandidate[]>();

  for (const candidate of params.candidates) {
    const list = grouped.get(candidate.isoDay) ?? [];
    list.push(candidate);
    grouped.set(candidate.isoDay, list);
  }

  const refs = new Map<string, CorpusLineRef>();
  for (const [isoDay, candidates] of grouped.entries()) {
    const sorted = candidates.sort(compareCandidatesByRecency);
    const lines = [
      `# Dream Session Corpus: ${isoDay}`,
      "",
      "Generated by memory-lancedb-pro dreaming compatibility sweep.",
      "",
    ];
    const filePath = path.join(corpusRoot, `${isoDay}.md`);
    for (const candidate of sorted) {
      const startLine = lines.length + 1;
      lines.push(buildCorpusLine(candidate));
      refs.set(candidate.entry.id, {
        path: filePath,
        startLine,
        endLine: startLine,
      });
    }
    lines.push("");
    await writeFileAtomic(filePath, lines.join("\n"));
  }

  return refs;
}

function buildShortTermEntry(candidate: DreamingCandidate, ref: CorpusLineRef): DreamingShortTermEntry {
  const recallDays = Array.from(
    new Set([
      toIsoDay(candidate.entry.timestamp),
      candidate.lastAccessedAt > 0 ? toIsoDay(candidate.lastAccessedAt) : undefined,
    ].filter((value): value is string => Boolean(value))),
  );
  const conceptTags = Array.from(
    new Set([
      candidate.metadata.memory_category,
      candidate.metadata.tier,
      candidate.entry.scope,
      candidate.entry.category,
    ].filter((value): value is string => typeof value === "string" && value.length > 0)),
  );
  const key = `${ref.path}:${ref.startLine}:${ref.endLine}`;
  const lastRecalledAt = candidate.lastAccessedAt > 0 ? toIsoTimestamp(candidate.lastAccessedAt) : undefined;
  const firstRecalledAt = candidate.accessCount > 0 ? toIsoTimestamp(candidate.entry.timestamp) : undefined;

  return {
    key,
    path: ref.path,
    startLine: ref.startLine,
    endLine: ref.endLine,
    source: "memory",
    snippet: candidate.snippet,
    recallCount: candidate.accessCount,
    dailyCount: 1,
    groundedCount: candidate.metadata.memory_layer === "durable" ? 1 : 0,
    totalScore: Number(candidate.score.toFixed(4)),
    maxScore: 1,
    ...firstRecalledAt ? { firstRecalledAt } : {},
    ...lastRecalledAt ? { lastRecalledAt } : {},
    queryHashes: [],
    recallDays,
    conceptTags,
    ...candidate.promoted
      ? { promotedAt: toIsoTimestamp(Math.max(candidate.lastAccessedAt || 0, candidate.entry.timestamp || 0)) }
      : {},
  };
}

function buildPhaseSignalEntry(candidate: DreamingCandidate, config: DreamingConfig): { lightHits: number; remHits: number } {
  const lightHits =
    config.phases.light.enabled && candidate.ageDays <= config.phases.light.lookbackDays
      ? Math.max(1, Math.min(6, 1 + Math.floor(candidate.accessCount / 2) + (candidate.score >= 0.7 ? 1 : 0)))
      : 0;
  const remHits =
    config.phases.rem.enabled &&
    candidate.ageDays <= config.phases.rem.lookbackDays &&
    (candidate.score >= config.phases.rem.minPatternStrength ||
      candidate.metadata.source === "reflection" ||
      candidate.entry.category === "reflection")
      ? Math.max(1, Math.min(4, (candidate.metadata.source === "reflection" ? 2 : 1) + Math.floor(candidate.score * 2)))
      : 0;

  return { lightHits, remHits };
}

async function appendDreamingEvent(params: {
  workspaceDir: string;
  nowMs: number;
  config: DreamingConfig;
  shortTermCount: number;
  promotedCount: number;
  reportPaths: string[];
}): Promise<void> {
  const eventPath = path.join(params.workspaceDir, DREAMING_EVENTS_RELATIVE_PATH);
  await mkdir(path.dirname(eventPath), { recursive: true });
  const record = {
    type: "memory.dream.completed",
    timestamp: toIsoTimestamp(params.nowMs),
    phase: "sweep",
    lineCount: params.shortTermCount,
    promotedCount: params.promotedCount,
    storageMode: params.config.storage.mode,
    reportPaths: params.reportPaths,
  };
  await appendFile(eventPath, `${JSON.stringify(record)}\n`, "utf-8");
}

export async function writeDreamingArtifacts(params: {
  workspaceDir: string;
  memories: MemoryEntry[];
  config: DreamingConfig;
  nowMs?: number;
}): Promise<DreamingWriteResult> {
  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const candidates = params.memories
    .map((entry) => buildCandidate(entry, nowMs, params.config))
    .filter((candidate): candidate is DreamingCandidate => Boolean(candidate))
    .sort(compareCandidatesByRecency);

  const perDayCap = Math.max(
    params.config.phases.light.limit,
    params.config.phases.rem.limit,
    params.config.phases.deep.limit,
    8,
  );
  const active: DreamingCandidate[] = [];
  const promoted: DreamingCandidate[] = [];
  const dayCounts = new Map<string, number>();

  for (const candidate of candidates) {
    const dayCount = dayCounts.get(candidate.isoDay) ?? 0;
    if (dayCount >= perDayCap && !candidate.promoted) continue;
    if (candidate.promoted) {
      promoted.push(candidate);
      continue;
    }
    active.push(candidate);
    dayCounts.set(candidate.isoDay, dayCount + 1);
  }

  const corpusRefs = await writeSessionCorpusFiles({
    workspaceDir: params.workspaceDir,
    candidates: [...active, ...promoted],
  });

  const shortTermEntries: Record<string, DreamingShortTermEntry> = {};
  const phaseSignalEntries: Record<string, { key: string; lightHits: number; remHits: number }> = {};
  let lightSignalCount = 0;
  let remSignalCount = 0;

  for (const candidate of [...active, ...promoted]) {
    const ref = corpusRefs.get(candidate.entry.id)
      ?? {
        path: path.join(params.workspaceDir, SESSION_CORPUS_RELATIVE_DIR, `${candidate.isoDay}.md`),
        startLine: 1,
        endLine: 1,
      };
    const entry = buildShortTermEntry(candidate, ref);
    shortTermEntries[entry.key] = entry;

    if (!candidate.promoted) {
      const phaseEntry = buildPhaseSignalEntry(candidate, params.config);
      if (phaseEntry.lightHits > 0 || phaseEntry.remHits > 0) {
        phaseSignalEntries[entry.key] = {
          key: entry.key,
          lightHits: phaseEntry.lightHits,
          remHits: phaseEntry.remHits,
        };
        lightSignalCount += phaseEntry.lightHits;
        remSignalCount += phaseEntry.remHits;
      }
    }
  }

  const storePath = path.join(params.workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
  const phaseSignalPath = path.join(params.workspaceDir, PHASE_SIGNAL_RELATIVE_PATH);
  await writeFileAtomic(storePath, `${JSON.stringify({
    version: 1,
    updatedAt: toIsoTimestamp(nowMs),
    entries: shortTermEntries,
  }, null, 2)}\n`);
  await writeFileAtomic(phaseSignalPath, `${JSON.stringify({
    version: 1,
    updatedAt: toIsoTimestamp(nowMs),
    entries: phaseSignalEntries,
  }, null, 2)}\n`);

  const dreamsPath = await writeDreamDiary({
    workspaceDir: params.workspaceDir,
    nowMs,
    config: params.config,
    active,
    promoted,
  });

  const reportPaths = await writePhaseReports({
    workspaceDir: params.workspaceDir,
    isoDay: toIsoDay(nowMs, params.config.timezone),
    config: params.config,
    active,
    promoted,
  });

  await appendDreamingEvent({
    workspaceDir: params.workspaceDir,
    nowMs,
    config: params.config,
    shortTermCount: active.length,
    promotedCount: promoted.length,
    reportPaths,
  });

  return {
    workspaceDir: params.workspaceDir,
    dreamsPath,
    storePath,
    phaseSignalPath,
    shortTermCount: active.length,
    promotedCount: promoted.length,
    lightSignalCount,
    remSignalCount,
    reportPaths,
  };
}
