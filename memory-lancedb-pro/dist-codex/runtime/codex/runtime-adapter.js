import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createEmbedder, getVectorDimensions, } from "../src/embedder.js";
import { createLlmClient } from "../src/llm-client.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG, } from "../src/retriever.js";
import { MemoryStore, validateStoragePath, } from "../src/store.js";
import { createScopeManager, } from "../src/scopes.js";
import { SmartExtractor } from "../src/smart-extractor.js";
const DEFAULT_VECTOR_DIM = 1536;
const CATEGORY_ENUM = [
    "preference",
    "fact",
    "decision",
    "entity",
    "reflection",
    "other",
];
function getDefaultDbPath() {
    return join(homedir(), ".openclaw", "memory", "lancedb-pro");
}
function getDefaultConfigPath() {
    return join(homedir(), ".codex", "memory-lancedb-pro", "config.json");
}
function resolveTemplateString(value) {
    return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
        const resolved = process.env[envVar];
        if (!resolved) {
            throw new Error(`Environment variable ${envVar} is not set`);
        }
        return resolved;
    });
}
function resolveEnvTemplates(value) {
    if (typeof value === "string") {
        return resolveTemplateString(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => resolveEnvTemplates(item));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveEnvTemplates(entry)]));
    }
    return value;
}
function parseBoolean(value) {
    if (!value)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized))
        return true;
    if (["0", "false", "no", "off"].includes(normalized))
        return false;
    return undefined;
}
function parseNumber(value) {
    if (!value)
        return undefined;
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : undefined;
}
function clampInt(value, fallback, min, max) {
    const numeric = Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(min, Math.min(max, numeric));
}
function clampImportance(value, fallback = 0.7) {
    const numeric = Number.isFinite(value) ? value : fallback;
    return Math.max(0, Math.min(1, numeric));
}
function splitCsv(value) {
    if (!value)
        return undefined;
    const parts = value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return parts.length > 0 ? parts : undefined;
}
function expandHomePath(value) {
    if (value === "~")
        return homedir();
    if (value.startsWith("~/")) {
        return join(homedir(), value.slice(2));
    }
    return value;
}
function resolveMaybeRelativePath(value, baseDir) {
    if (!value)
        return undefined;
    const expanded = expandHomePath(value);
    if (isAbsolute(expanded))
        return expanded;
    if (baseDir)
        return resolve(baseDir, expanded);
    return resolve(expanded);
}
function normalizeCategory(value) {
    if (!value)
        return undefined;
    const normalized = value.trim();
    return CATEGORY_ENUM.includes(normalized) ? normalized : undefined;
}
function pickPrimaryApiKey(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => entry.trim()).find(Boolean);
    }
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function buildEnvConfig() {
    const apiKeys = splitCsv(process.env.MEMORY_LANCEDB_PRO_API_KEYS);
    const apiKey = process.env.MEMORY_LANCEDB_PRO_API_KEY?.trim();
    const embedding = apiKeys ||
        apiKey ||
        process.env.MEMORY_LANCEDB_PRO_MODEL ||
        process.env.MEMORY_LANCEDB_PRO_BASE_URL
        ? {
            provider: "openai-compatible",
            apiKey: apiKeys ?? apiKey,
            model: process.env.MEMORY_LANCEDB_PRO_MODEL?.trim(),
            baseURL: process.env.MEMORY_LANCEDB_PRO_BASE_URL?.trim(),
            dimensions: parseNumber(process.env.MEMORY_LANCEDB_PRO_DIMENSIONS),
            taskQuery: process.env.MEMORY_LANCEDB_PRO_TASK_QUERY?.trim(),
            taskPassage: process.env.MEMORY_LANCEDB_PRO_TASK_PASSAGE?.trim(),
            normalized: parseBoolean(process.env.MEMORY_LANCEDB_PRO_NORMALIZED),
            chunking: parseBoolean(process.env.MEMORY_LANCEDB_PRO_CHUNKING),
        }
        : undefined;
    const llmApiKeys = splitCsv(process.env.MEMORY_LANCEDB_PRO_LLM_API_KEYS);
    const llmApiKey = process.env.MEMORY_LANCEDB_PRO_LLM_API_KEY?.trim();
    const llm = llmApiKeys ||
        llmApiKey ||
        process.env.MEMORY_LANCEDB_PRO_LLM_MODEL ||
        process.env.MEMORY_LANCEDB_PRO_LLM_BASE_URL
        ? {
            apiKey: llmApiKeys ?? llmApiKey,
            model: process.env.MEMORY_LANCEDB_PRO_LLM_MODEL?.trim(),
            baseURL: process.env.MEMORY_LANCEDB_PRO_LLM_BASE_URL?.trim(),
        }
        : undefined;
    const retrieval = {};
    const mode = process.env.MEMORY_LANCEDB_PRO_RETRIEVAL_MODE?.trim();
    if (mode === "hybrid" || mode === "vector")
        retrieval.mode = mode;
    const rerank = process.env.MEMORY_LANCEDB_PRO_RERANK?.trim();
    if (rerank === "cross-encoder" || rerank === "lightweight" || rerank === "none") {
        retrieval.rerank = rerank;
    }
    const rerankProvider = process.env.MEMORY_LANCEDB_PRO_RERANK_PROVIDER?.trim();
    if (rerankProvider === "jina" ||
        rerankProvider === "dashscope" ||
        rerankProvider === "siliconflow" ||
        rerankProvider === "voyage" ||
        rerankProvider === "pinecone") {
        retrieval.rerankProvider = rerankProvider;
    }
    const vectorWeight = parseNumber(process.env.MEMORY_LANCEDB_PRO_VECTOR_WEIGHT);
    if (vectorWeight !== undefined)
        retrieval.vectorWeight = vectorWeight;
    const bm25Weight = parseNumber(process.env.MEMORY_LANCEDB_PRO_BM25_WEIGHT);
    if (bm25Weight !== undefined)
        retrieval.bm25Weight = bm25Weight;
    const minScore = parseNumber(process.env.MEMORY_LANCEDB_PRO_MIN_SCORE);
    if (minScore !== undefined)
        retrieval.minScore = minScore;
    const hardMinScore = parseNumber(process.env.MEMORY_LANCEDB_PRO_HARD_MIN_SCORE);
    if (hardMinScore !== undefined)
        retrieval.hardMinScore = hardMinScore;
    const candidatePoolSize = parseNumber(process.env.MEMORY_LANCEDB_PRO_CANDIDATE_POOL_SIZE);
    if (candidatePoolSize !== undefined)
        retrieval.candidatePoolSize = candidatePoolSize;
    if (process.env.MEMORY_LANCEDB_PRO_RERANK_API_KEY) {
        retrieval.rerankApiKey = process.env.MEMORY_LANCEDB_PRO_RERANK_API_KEY.trim();
    }
    if (process.env.MEMORY_LANCEDB_PRO_RERANK_MODEL) {
        retrieval.rerankModel = process.env.MEMORY_LANCEDB_PRO_RERANK_MODEL.trim();
    }
    if (process.env.MEMORY_LANCEDB_PRO_RERANK_ENDPOINT) {
        retrieval.rerankEndpoint = process.env.MEMORY_LANCEDB_PRO_RERANK_ENDPOINT.trim();
    }
    const defaultScope = process.env.MEMORY_LANCEDB_PRO_DEFAULT_SCOPE?.trim();
    const smartExtraction = parseBoolean(process.env.MEMORY_LANCEDB_PRO_SMART_EXTRACTION);
    const extractMinMessages = parseNumber(process.env.MEMORY_LANCEDB_PRO_EXTRACT_MIN_MESSAGES);
    const extractMaxChars = parseNumber(process.env.MEMORY_LANCEDB_PRO_EXTRACT_MAX_CHARS);
    return {
        dbPath: process.env.MEMORY_LANCEDB_PRO_DB_PATH?.trim(),
        embedding,
        llm,
        retrieval: Object.keys(retrieval).length > 0 ? retrieval : undefined,
        smartExtraction,
        extractMinMessages,
        extractMaxChars,
        scopes: defaultScope
            ? {
                default: defaultScope,
                definitions: {
                    [defaultScope]: {
                        description: "Default scope injected from MEMORY_LANCEDB_PRO_DEFAULT_SCOPE",
                    },
                },
            }
            : undefined,
    };
}
function mergeScopes(base, overrides) {
    if (!base && !overrides)
        return undefined;
    return {
        ...base,
        ...overrides,
        definitions: {
            ...(base?.definitions ?? {}),
            ...(overrides?.definitions ?? {}),
        },
        agentAccess: {
            ...(base?.agentAccess ?? {}),
            ...(overrides?.agentAccess ?? {}),
        },
    };
}
function mergeDefined(base, overrides) {
    if (!overrides)
        return { ...base };
    const next = { ...base };
    for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) {
            next[key] = value;
        }
    }
    return next;
}
function mergeConfig(base, overrides) {
    const merged = mergeDefined(base, overrides);
    if (base.embedding || overrides.embedding) {
        merged.embedding = mergeDefined((base.embedding ?? {}), (overrides.embedding ?? {}));
    }
    if (base.retrieval || overrides.retrieval) {
        merged.retrieval = mergeDefined((base.retrieval ?? {}), (overrides.retrieval ?? {}));
    }
    if (base.llm || overrides.llm) {
        merged.llm = mergeDefined((base.llm ?? {}), (overrides.llm ?? {}));
    }
    merged.scopes = mergeScopes(base.scopes, overrides.scopes);
    return merged;
}
async function readConfigFile(configPath) {
    const raw = await readFile(configPath, "utf8");
    const parsed = JSON.parse(raw);
    const resolved = resolveEnvTemplates(parsed);
    const baseDir = resolve(configPath, "..");
    if (resolved.dbPath) {
        resolved.dbPath = resolveMaybeRelativePath(resolved.dbPath, baseDir);
    }
    return resolved;
}
async function loadConfig(options = {}) {
    const envConfigPath = process.env.MEMORY_LANCEDB_PRO_CONFIG
        ? resolveMaybeRelativePath(process.env.MEMORY_LANCEDB_PRO_CONFIG)
        : undefined;
    const candidatePaths = [
        envConfigPath,
        ...(options.configPathCandidates ?? []),
        getDefaultConfigPath(),
    ]
        .filter(Boolean)
        .map((entry) => resolve(entry));
    for (const candidate of candidatePaths) {
        if (existsSync(candidate)) {
            return {
                config: await readConfigFile(candidate),
                configPath: candidate,
            };
        }
    }
    return {
        config: {},
        configPath: null,
    };
}
function getConfiguredVectorDimensions(config) {
    const model = config.embedding?.model;
    const dimensions = config.embedding?.dimensions;
    if (model) {
        try {
            return getVectorDimensions(model, dimensions);
        }
        catch {
            if (dimensions && dimensions > 0)
                return dimensions;
        }
    }
    if (dimensions && dimensions > 0)
        return dimensions;
    return DEFAULT_VECTOR_DIM;
}
function hasEmbeddingConfig(config) {
    const apiKey = config.embedding?.apiKey;
    const model = config.embedding?.model;
    if (!model)
        return false;
    if (Array.isArray(apiKey)) {
        return apiKey.length > 0 && apiKey.every((entry) => typeof entry === "string" && entry.trim().length > 0);
    }
    return typeof apiKey === "string" && apiKey.trim().length > 0;
}
function parseMetadata(metadata) {
    if (!metadata)
        return null;
    try {
        const parsed = JSON.parse(metadata);
        return parsed && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
}
function serializeEntry(entry, score, sources) {
    return {
        id: entry.id,
        text: entry.text,
        category: entry.category,
        scope: entry.scope,
        importance: entry.importance,
        timestamp: entry.timestamp,
        metadata: parseMetadata(entry.metadata),
        score,
        sources,
    };
}
export class CodexMemoryRuntime {
    config;
    configPath;
    scopeManager;
    summary;
    dbPath;
    vectorDimensions;
    store = null;
    embedder = null;
    retriever = null;
    llmClient = null;
    smartExtractor = null;
    constructor(loaded) {
        const merged = mergeConfig({
            dbPath: getDefaultDbPath(),
            scopes: {
                default: "global",
                definitions: {
                    global: {
                        description: "Shared knowledge across Codex sessions",
                    },
                },
                agentAccess: {},
            },
        }, mergeConfig(loaded.config, buildEnvConfig()));
        this.config = merged;
        this.configPath = loaded.configPath;
        this.dbPath = validateStoragePath(merged.dbPath || getDefaultDbPath());
        this.vectorDimensions = getConfiguredVectorDimensions(merged);
        this.scopeManager = createScopeManager(merged.scopes);
        this.summary = {
            dbPath: this.dbPath,
            defaultScope: this.scopeManager.getDefaultScope(),
            configPath: this.configPath,
            embeddingConfigured: hasEmbeddingConfig(this.config),
            retrievalMode: (this.config.retrieval?.mode ?? DEFAULT_RETRIEVAL_CONFIG.mode),
            vectorDimensions: this.vectorDimensions,
        };
    }
    getSummary() {
        return { ...this.summary };
    }
    getScopeFilter(scope) {
        if (!scope)
            return undefined;
        const trimmed = scope.trim();
        if (!trimmed)
            return undefined;
        if (!this.scopeManager.validateScope(trimmed)) {
            throw new Error(`Invalid scope "${trimmed}". Use "global" or a built-in pattern like "project:<id>", "agent:<id>", "user:<id>", or "custom:<id>".`);
        }
        return [trimmed];
    }
    resolveScope(scope) {
        const trimmed = scope?.trim();
        if (!trimmed) {
            return this.scopeManager.getDefaultScope();
        }
        if (!this.scopeManager.validateScope(trimmed)) {
            throw new Error(`Invalid scope "${trimmed}". Use "global" or a built-in pattern like "project:<id>", "agent:<id>", "user:<id>", or "custom:<id>".`);
        }
        return trimmed;
    }
    resolveScopeFilterList(scopes) {
        if (!scopes || scopes.length === 0)
            return undefined;
        const normalized = scopes
            .map((scope) => scope.trim())
            .filter(Boolean)
            .map((scope) => this.resolveScope(scope));
        return normalized.length > 0 ? [...new Set(normalized)] : undefined;
    }
    getStore() {
        if (!this.store) {
            this.store = new MemoryStore({
                dbPath: this.dbPath,
                vectorDim: this.vectorDimensions,
            });
        }
        return this.store;
    }
    getEmbedder() {
        if (this.embedder)
            return this.embedder;
        if (!hasEmbeddingConfig(this.config)) {
            throw new Error("Embedding config is missing. Add plugins/memory-lancedb-pro/config.json or ~/.codex/memory-lancedb-pro/config.json with embedding.apiKey and embedding.model.");
        }
        this.embedder = createEmbedder({
            provider: "openai-compatible",
            ...this.config.embedding,
            apiKey: this.config.embedding.apiKey,
            model: this.config.embedding.model,
        });
        return this.embedder;
    }
    getRetriever() {
        if (this.retriever)
            return this.retriever;
        this.retriever = createRetriever(this.getStore(), this.getEmbedder(), this.config.retrieval);
        return this.retriever;
    }
    getLlmClient() {
        if (this.llmClient)
            return this.llmClient;
        const apiKey = pickPrimaryApiKey(this.config.llm?.apiKey) ??
            pickPrimaryApiKey(this.config.embedding?.apiKey);
        if (!apiKey) {
            throw new Error("LLM config is missing. Add llm.apiKey or reuse embedding.apiKey in plugins/memory-lancedb-pro/config.json.");
        }
        this.llmClient = createLlmClient({
            apiKey,
            model: this.config.llm?.model?.trim() || "openai/gpt-oss-120b",
            baseURL: this.config.llm?.baseURL?.trim() || this.config.embedding?.baseURL?.trim(),
            timeoutMs: 30000,
        });
        return this.llmClient;
    }
    getSmartExtractor() {
        if (this.smartExtractor)
            return this.smartExtractor;
        this.smartExtractor = new SmartExtractor(this.getStore(), this.getEmbedder(), this.getLlmClient(), {
            user: "User",
            extractMinMessages: clampInt(this.config.extractMinMessages, 2, 1, 100),
            extractMaxChars: clampInt(this.config.extractMaxChars, 8000, 200, 200_000),
            defaultScope: this.summary.defaultScope,
            log: () => { },
            debugLog: () => { },
        });
        return this.smartExtractor;
    }
    async health(testEmbeddings = false) {
        const store = this.getStore();
        await store.ensureReady();
        const report = {
            ...this.summary,
            ftsAvailable: store.hasFtsSupport,
            ftsError: store.lastFtsError,
        };
        if (testEmbeddings && hasEmbeddingConfig(this.config)) {
            report.embedderTest = await this.getEmbedder().test();
        }
        return report;
    }
    async recall(params) {
        const query = params.query.trim();
        if (!query) {
            throw new Error("memory_recall requires a non-empty query");
        }
        const limit = clampInt(params.limit, 5, 1, 20);
        const scopeFilter = this.getScopeFilter(params.scope);
        const category = params.category ? normalizeCategory(params.category) : undefined;
        if (hasEmbeddingConfig(this.config)) {
            const results = await this.getRetriever().retrieve({
                query,
                limit,
                scopeFilter,
                category,
                source: "manual",
            });
            return {
                mode: this.summary.retrievalMode,
                count: results.length,
                memories: results.map((result) => serializeEntry(result.entry, result.score, result.sources)),
            };
        }
        const results = await this.getStore().bm25Search(query, limit, scopeFilter, {
            excludeInactive: true,
        });
        const filtered = category
            ? results.filter((result) => result.entry.category === category)
            : results;
        return {
            mode: "bm25-only",
            count: filtered.length,
            memories: filtered.map((result) => serializeEntry(result.entry, result.score, {
                bm25: { score: result.score, rank: 0 },
            })),
        };
    }
    async storeMemory(params) {
        const text = params.text.trim();
        if (!text) {
            throw new Error("memory_store requires non-empty text");
        }
        const embedder = this.getEmbedder();
        const vector = await embedder.embedPassage(text);
        const stored = await this.getStore().store({
            text,
            vector,
            category: normalizeCategory(params.category) ?? "other",
            scope: this.resolveScope(params.scope),
            importance: clampImportance(params.importance),
            metadata: JSON.stringify(params.metadata ?? {}),
        });
        return serializeEntry(stored);
    }
    async updateMemory(params) {
        const hasAnyField = params.text !== undefined ||
            params.category !== undefined ||
            params.importance !== undefined ||
            params.metadata !== undefined ||
            params.metadataPatch !== undefined;
        if (!hasAnyField) {
            throw new Error("memory_update requires at least one field to change");
        }
        if (params.metadata && params.metadataPatch) {
            throw new Error("Provide either metadata or metadataPatch, not both");
        }
        const store = this.getStore();
        const scopeFilter = undefined;
        if (params.metadataPatch) {
            const patched = await store.patchMetadata(params.id, params.metadataPatch, scopeFilter);
            if (!patched) {
                throw new Error(`Memory ${params.id} was not found`);
            }
            return serializeEntry(patched);
        }
        const updates = {};
        if (params.text !== undefined) {
            const nextText = params.text.trim();
            if (!nextText) {
                throw new Error("memory_update text cannot be empty");
            }
            updates.text = nextText;
            updates.vector = await this.getEmbedder().embedPassage(nextText);
        }
        if (params.category !== undefined) {
            const category = normalizeCategory(params.category);
            if (!category) {
                throw new Error(`Unsupported category: ${params.category}`);
            }
            updates.category = category;
        }
        if (params.importance !== undefined) {
            updates.importance = clampImportance(params.importance);
        }
        if (params.metadata !== undefined) {
            updates.metadata = JSON.stringify(params.metadata);
        }
        const updated = await store.update(params.id, updates, scopeFilter);
        if (!updated) {
            throw new Error(`Memory ${params.id} was not found`);
        }
        return serializeEntry(updated);
    }
    async forgetMemory(params) {
        const deleted = await this.getStore().delete(params.id, this.getScopeFilter(params.scope));
        return {
            deleted,
            id: params.id,
        };
    }
    async listMemories(params = {}) {
        const entries = await this.getStore().list(this.getScopeFilter(params.scope), normalizeCategory(params.category), clampInt(params.limit, 20, 1, 100), clampInt(params.offset, 0, 0, 10_000));
        return {
            count: entries.length,
            memories: entries.map((entry) => serializeEntry(entry)),
        };
    }
    async stats(params = {}) {
        const store = this.getStore();
        const stats = await store.stats(this.getScopeFilter(params.scope));
        return {
            ...stats,
            ftsStatus: store.getFtsStatus(),
            dbPath: this.dbPath,
            defaultScope: this.summary.defaultScope,
        };
    }
    async extractAndStoreMemories(params) {
        const conversationText = params.conversationText.trim();
        if (!conversationText) {
            throw new Error("memory_extract_and_store requires non-empty conversationText");
        }
        const scope = this.resolveScope(params.scope);
        const scopeFilter = this.resolveScopeFilterList(params.scopeFilter) ?? [scope];
        const sessionKey = params.sessionKey?.trim() || `codex-extract:${Date.now()}`;
        const stats = await this.getSmartExtractor().extractAndPersist(conversationText, sessionKey, {
            scope,
            scopeFilter,
        });
        const rejected = stats.rejected ?? 0;
        const supported = stats.supported ?? 0;
        const superseded = stats.superseded ?? 0;
        return {
            sessionKey,
            scope,
            scopeFilter,
            conversationChars: conversationText.length,
            created: stats.created,
            merged: stats.merged,
            skipped: stats.skipped,
            rejected,
            supported,
            superseded,
            handled: stats.created > 0 ||
                stats.merged > 0 ||
                stats.skipped > 0 ||
                rejected > 0 ||
                supported > 0 ||
                superseded > 0,
        };
    }
}
export async function createCodexMemoryRuntime(options = {}) {
    const loaded = await loadConfig(options);
    return new CodexMemoryRuntime(loaded);
}
