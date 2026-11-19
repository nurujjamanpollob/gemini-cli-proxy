import {
    API_VERSION,
    PROVISION_ENDPOINTS,
    antigravityHeaders,
} from "../utils/antigravity-constants.js";
import { getLogger } from "../utils/logger.js";
import chalk from "chalk";

const logger = getLogger("AGY-MODELS", chalk.blue);

export type ModelFamily = "gemini" | "claude" | "other";

/** Capability buckets callers map onto; the backend serves different ids. */
export type TierRole = "opus" | "sonnet" | "pro" | "flash" | "lite";

export interface AntigravityModel {
    id: string;
    displayName?: string;
    family: ModelFamily;
    supportsThinking: boolean;
    maxOutputTokens?: number;
}

export interface ResolvedModel {
    id: string;
    family: ModelFamily;
    supportsThinking: boolean;
    maxOutputTokens?: number;
    role: TierRole;
}

/** Catalogue TTL — the backend rewrites entitlements roughly per session. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

/** Seed list, used only when `fetchAvailableModels` is unreachable (verified 2026-11-19). */
const SEED_MODEL_IDS: readonly string[] = [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-tiered",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
];

/**
 * Preference order per capability bucket, strongest first. Only ids that the
 * live backend actually serves are listed; `pickForRole` skips absent ones.
 */
const TIER_PREFERENCE: Record<TierRole, readonly string[]> = {
    opus: ["claude-opus-4-6-thinking", "claude-sonnet-4-6"],
    sonnet: ["claude-sonnet-4-6", "claude-opus-4-6-thinking"],
    pro: [
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-tiered",
        "gemini-3.8-flash-medium",
        "gemini-2.5-pro",
    ],
    flash: [
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.5-flash-lite",
        "gemini-2.5-flash-thinking",
        "gemini-2.5-flash",
    ],
    lite: [
        "gemini-3.1-flash-lite",
        "gemini-3.5-flash-lite",
        "gemini-2.5-flash-lite",
        "gemini-3.8-flash-low",
    ],
};

/** What an unrecognised model name degrades to. */
const DEFAULT_ROLE: TierRole = "pro";

/** Client-facing names mapped onto capability buckets, not onto backend ids. */
const ROLE_ALIASES: Record<string, TierRole> = {
    // Gemini Pro line (any generation) -> strongest tier
    "gemini-pro": "pro",
    "gemini-2.5-pro": "pro",
    "gemini-3-pro": "pro",
    "gemini-3-pro-preview": "pro",
    "gemini-3-pro-high": "pro",
    "gemini-3-pro-low": "flash",
    "gemini-3.1-pro": "pro",
    "gemini-3.1-pro-preview": "pro",
    "gemini-3.1-pro-high": "pro",
    "gemini-3.1-pro-low": "flash",
    // Gemini Flash line
    "gemini-flash": "flash",
    "gemini-2.5-flash": "flash",
    "gemini-2.5-flash-thinking": "flash",
    "gemini-3-flash": "flash",
    "gemini-3-flash-preview": "flash",
    "gemini-3-flash-thinking": "flash",
    "gemini-3.5-flash": "flash",
    // Gemini Lite line
    "gemini-2.5-flash-lite": "lite",
    "gemini-3.1-flash-lite": "lite",
    "gemini-3.1-flash-lite-preview": "lite",
    "gemini-3.5-flash-lite": "lite",
    // Third-party families served by the same backend
    "gpt-oss-120b": "flash",
    "gpt-oss-20b": "lite",
};

interface CatalogueCache {
    models: AntigravityModel[];
    fetchedAt: number;
}

let cache: CatalogueCache | null = null;

function familyOf(id: string): ModelFamily {
    const lower = id.toLowerCase();
    if (lower.includes("claude")) {
        return "claude";
    }
    if (lower.includes("gemini")) {
        return "gemini";
    }
    return "other";
}

/** Names that are never user-selectable models on this backend. */
function isInternalModel(id: string): boolean {
    const lower = id.toLowerCase();
    return (
        lower.startsWith("tab_") ||
        lower.startsWith("chat_") ||
        lower.endsWith("-disabled") ||
        lower.includes("embedding") ||
        lower.includes("rerank")
    );
}

/**
 * Pulls the live catalogue from `v1internal:fetchAvailableModels`.
 * Returns null instead of throwing so callers can fall back to the seed list.
 */
export async function fetchCatalogue(
    accessToken: string,
    projectId?: string | null,
): Promise<AntigravityModel[] | null> {
    if (cache && Date.now() - cache.fetchedAt < CATALOGUE_TTL_MS) {
        return cache.models;
    }

    for (const endpoint of PROVISION_ENDPOINTS) {
        try {
            const response = await fetch(`${endpoint}/${API_VERSION}:fetchAvailableModels`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    ...antigravityHeaders("application/json"),
                },
                body: JSON.stringify(projectId ? { project: projectId } : {}),
            });

            if (!response.ok) {
                logger.warn(`fetchAvailableModels rejected by ${endpoint} with ${response.status}`);
                continue;
            }

            const payload = (await response.json()) as {
                models?: Record<
                    string,
                    { displayName?: string; supportsThinking?: boolean; maxOutputTokens?: number }
                >;
            };
            const entries = Object.entries(payload.models ?? {});
            if (entries.length === 0) {
                continue;
            }

            const models: AntigravityModel[] = entries
                .filter(([id]) => !isInternalModel(id))
                .map(([id, meta]) => ({
                    id,
                    displayName: meta?.displayName ?? id,
                    family: familyOf(id),
                    supportsThinking: meta?.supportsThinking === true || id.includes("thinking"),
                    maxOutputTokens: meta?.maxOutputTokens,
                }));

            cache = { models, fetchedAt: Date.now() };
            logger.debug(`catalogue refreshed with ${models.length} selectable models`);
            return models;
        } catch (error) {
            logger.warn(`fetchAvailableModels failed at ${endpoint}: ${(error as Error).message}`);
        }
    }

    return cache?.models ?? null;
}

/** Catalogue to reason about right now: live cache first, seed list otherwise. */
export function knownCatalogue(): AntigravityModel[] {
    return cache?.models ?? SEED_MODEL_IDS.map((id) => ({
        id,
        displayName: id,
        family: familyOf(id),
        supportsThinking: id.includes("thinking"),
    }));
}

/** Classifies a caller-supplied name into a capability bucket. */
function roleOf(name: string): TierRole | null {
    const lower = name.toLowerCase();

    if (/opus/.test(lower)) {
        return "opus";
    }
    if (/(claude|sonnet|haiku)/.test(lower) || /^(gpt-4|o[134])/.test(lower)) {
        return /haiku/.test(lower) ? "lite" : "sonnet";
    }
    if (/lite|mini|-low$|flash-low/.test(lower)) {
        return "lite";
    }
    if (/pro|max|high/.test(lower)) {
        return "pro";
    }
    if (/flash|fast|turbo/.test(lower)) {
        return "flash";
    }
    return null;
}

function toResolved(model: AntigravityModel, role: TierRole): ResolvedModel {
    return {
        id: model.id,
        family: model.family,
        supportsThinking: model.supportsThinking,
        maxOutputTokens: model.maxOutputTokens,
        role,
    };
}

/** First catalogue member of a bucket's preference order. */
function pickForRole(role: TierRole, catalogue: AntigravityModel[]): ResolvedModel | null {
    for (const id of TIER_PREFERENCE[role]) {
        const hit = catalogue.find((m) => m.id === id);
        if (hit) {
            return toResolved(hit, role);
        }
    }

    const family: ModelFamily = role === "opus" || role === "sonnet" ? "claude" : "gemini";
    const sameFamily = catalogue.find((m) => m.family === family);
    return sameFamily ? toResolved(sameFamily, role) : null;
}

/**
 * Maps any caller-supplied model name onto a model the Antigravity tier serves.
 * Unknown names degrade to the strongest Gemini bucket instead of failing.
 */
export function resolveModel(requested: string | undefined): ResolvedModel {
    const catalogue = knownCatalogue();
    const clean = (requested ?? "").replace(/\[\d+m\]$/, "");

    const exact = catalogue.find((m) => m.id === clean);
    if (exact) {
        return toResolved(exact, roleOf(clean) ?? DEFAULT_ROLE);
    }

    const aliasRole = ROLE_ALIASES[clean];
    const wanted: TierRole = aliasRole ?? roleOf(clean) ?? DEFAULT_ROLE;

    const picked = pickForRole(wanted, catalogue);
    if (picked) {
        if (!aliasRole && wanted !== DEFAULT_ROLE) {
            logger.debug(`model "${clean}" resolved to bucket ${wanted} -> ${picked.id}`);
        }
        return picked;
    }

    const lastResort = catalogue[0];
    logger.warn(`no Antigravity model matches "${clean}"; using ${lastResort.id}`);
    return toResolved(lastResort, DEFAULT_ROLE);
}

/**
 * Quota fallback chain for a resolved model: same bucket first, then the other
 * buckets of the same family, so a 429 on one tier keeps the request alive.
 */
export function fallbackChain(model: ResolvedModel, limit = 3): ResolvedModel[] {
    const catalogue = knownCatalogue();
    const chain: ResolvedModel[] = [model];
    const seen = new Set([model.id]);

    const push = (candidate: AntigravityModel | undefined, role: TierRole): void => {
        if (!candidate || seen.has(candidate.id) || chain.length >= limit) {
            return;
        }
        seen.add(candidate.id);
        chain.push(toResolved(candidate, role));
    };

    const byId = (id: string): AntigravityModel | undefined => catalogue.find((m) => m.id === id);

    for (const id of TIER_PREFERENCE[model.role]) {
        push(byId(id), model.role);
    }

    const rolesInFamily: TierRole[] =
      model.family === "claude" ? ["opus", "sonnet"] : ["pro", "flash", "lite"];
    for (const role of rolesInFamily) {
        if (role === model.role) {
            continue;
        }
        for (const id of TIER_PREFERENCE[role]) {
            push(byId(id), role);
        }
    }

    return chain.slice(0, limit);
}

export function clearCatalogueCache(): void {
    cache = null;
}
