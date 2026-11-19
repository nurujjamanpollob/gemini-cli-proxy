import chalk from "chalk";

import {
    API_VERSION,
    GENERATE_ENDPOINTS,
    PROVISION_ENDPOINTS,
    antigravityHeaders,
} from "../utils/antigravity-constants.js";
import { getLogger } from "../utils/logger.js";
import type { AntigravityModel } from "./antigravity-catalogue-data.js";
import {
    CATALOGUE_TTL_MS,
    SEED_MODEL_IDS,
    familyOf,
    isInternalModel,
} from "./antigravity-catalogue-data.js";

const logger = getLogger("AGY-CATALOGUE", chalk.blue);

/** Per-host budget for `fetchAvailableModels`; a stalled host must not wedge `/models`. */
const CATALOGUE_TIMEOUT_MS = readPositiveInt(
    process.env.ANTIGRAVITY_CATALOGUE_TIMEOUT_MS,
    15_000,
);

interface CatalogueCache {
    models: AntigravityModel[];
    fetchedAt: number;
}

let cache: CatalogueCache | null = null;

function readPositiveInt(raw: string | undefined, fallback: number): number {
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Normalised, filtered answer from a single provisioning host. Throws on failure. */
async function fetchFromEndpoint(
    endpoint: string,
    accessToken: string,
    projectId?: string | null,
): Promise<AntigravityModel[]> {
    const response = await fetch(`${endpoint}/${API_VERSION}:fetchAvailableModels`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...antigravityHeaders("application/json"),
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
        signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
        models?: Record<
            string,
            { displayName?: string; supportsThinking?: boolean; maxOutputTokens?: number }
        >;
    };

    return Object.entries(payload.models ?? {})
        .filter(([id]) => !isInternalModel(id))
        .map(([id, meta]) => ({
            id,
            // Upstream sends an empty string for several ids; the id is then all we have.
            displayName: meta?.displayName || id,
            family: familyOf(id),
            supportsThinking: meta?.supportsThinking === true || id.includes("thinking"),
            maxOutputTokens: meta?.maxOutputTokens,
            endpoints: [endpoint],
        }));
}

/**
 * Unions per-host answers into one catalogue. The first host to list an id owns
 * its metadata; later hosts only contribute endpoint affinity.
 */
function mergeCatalogue(batches: readonly (readonly AntigravityModel[])[]): AntigravityModel[] {
    const merged = new Map<string, AntigravityModel>();

    for (const batch of batches) {
        for (const model of batch) {
            const existing = merged.get(model.id);
            if (!existing) {
                merged.set(model.id, { ...model, endpoints: [...model.endpoints] });
                continue;
            }

            const ceiling = Math.max(existing.maxOutputTokens ?? 0, model.maxOutputTokens ?? 0);
            merged.set(model.id, {
                ...existing,
                displayName: existing.displayName || model.displayName,
                supportsThinking: existing.supportsThinking || model.supportsThinking,
                maxOutputTokens: ceiling > 0 ? ceiling : undefined,
                endpoints: [...new Set([...existing.endpoints, ...model.endpoints])],
            });
        }
    }

    return [...merged.values()];
}

/**
 * Pulls the live catalogue from **every** provisioning host and unions the
 * answers. Neither host is complete: production omits daily-only ids such as
 * `gemini-4-hydrogen-sonar`, while daily carries internal entries that get
 * filtered out. One host failing (or timing out) never truncates the list.
 * Returns null instead of throwing so callers can fall back to the seed list.
 */
export async function fetchCatalogue(
    accessToken: string,
    projectId?: string | null,
): Promise<AntigravityModel[] | null> {
    if (cache && Date.now() - cache.fetchedAt < CATALOGUE_TTL_MS) {
        return cache.models;
    }

    const settled = await Promise.allSettled(
        PROVISION_ENDPOINTS.map((endpoint) => fetchFromEndpoint(endpoint, accessToken, projectId)),
    );

    const batches: AntigravityModel[][] = [];
    settled.forEach((entry, index) => {
        if (entry.status === "fulfilled") {
            if (entry.value.length > 0) {
                batches.push(entry.value);
            }
            return;
        }
        const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
        logger.warn(`fetchAvailableModels failed at ${PROVISION_ENDPOINTS[index]}: ${reason}`);
    });

    const models = mergeCatalogue(batches);
    if (models.length === 0) {
        // Never cache the seed list as if it were live data.
        return cache?.models ?? null;
    }

    cache = { models, fetchedAt: Date.now() };
    logger.debug(`catalogue refreshed with ${models.length} selectable models from ${batches.length} host(s)`);
    return models;
}

/** Catalogue to reason about right now: live cache first, seed list otherwise. */
export function knownCatalogue(): AntigravityModel[] {
    if (cache) {
        return cache.models;
    }

    return SEED_MODEL_IDS.map((id) => ({
        id,
        displayName: id,
        family: familyOf(id),
        supportsThinking: id.includes("thinking"),
        endpoints: [],
    }));
}

/**
 * Endpoint order for one model: hosts proven to serve it first, the rest only as
 * a last resort. Production answers `429` (not `404`) for ids it does not list,
 * so probing it for daily-only models both wastes a request and misreports the
 * failure as quota exhaustion.
 */
export function generationEndpoints(
    model?: { endpoints?: readonly string[] },
): string[] {
    const affinity = model?.endpoints ?? [];
    if (affinity.length === 0) {
        return [...GENERATE_ENDPOINTS];
    }

    const proven = GENERATE_ENDPOINTS.filter((endpoint) => affinity.includes(endpoint));
    const fallback = GENERATE_ENDPOINTS.filter((endpoint) => !affinity.includes(endpoint));
    return [...proven, ...fallback];
}

export function clearCatalogueCache(): void {
    cache = null;
}
