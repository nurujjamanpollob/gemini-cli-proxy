/**
 * Model resolution policy for the Antigravity upstream.
 *
 * Callers name capabilities, not backend ids: every request is classified into a
 * `TierRole` bucket and resolved against the live catalogue that
 * `antigravity-catalogue.ts` unions from both provisioning hosts. This module is
 * also the public surface of the component — the fetch/affinity helpers are
 * re-exported so consumers keep a single import point.
 */
import chalk from "chalk";

import { getLogger } from "../utils/logger.js";
import {
    clearCatalogueCache,
    fetchCatalogue,
    generationEndpoints,
    knownCatalogue,
} from "./antigravity-catalogue.js";
import type {
    AntigravityModel,
    ModelFamily,
    ResolvedModel,
    TierRole,
} from "./antigravity-catalogue-data.js";
import {
    DEFAULT_ROLE,
    ROLE_ALIASES,
    TIER_PREFERENCE,
} from "./antigravity-catalogue-data.js";

const logger = getLogger("AGY-MODELS", chalk.blue);

export type { AntigravityModel, ModelFamily, ResolvedModel, TierRole };
export { clearCatalogueCache, fetchCatalogue, generationEndpoints, knownCatalogue };

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
        endpoints: [...model.endpoints],
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
 * Exact live ids always win (that is how daily-only and image tiers are reached);
 * everything else degrades to its capability bucket instead of failing.
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
