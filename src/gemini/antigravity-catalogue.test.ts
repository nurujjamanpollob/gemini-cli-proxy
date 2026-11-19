import {beforeEach, describe, expect, it, vi} from "vitest";

import {
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_PROD,
    GENERATE_ENDPOINTS,
} from "../utils/antigravity-constants.js";
import {
    clearCatalogueCache,
    fetchCatalogue,
    generationEndpoints,
    knownCatalogue,
} from "./antigravity-catalogue.js";
import {resolveModel} from "./antigravity-models.js";

const PROD = ANTIGRAVITY_ENDPOINT_PROD;
const DAILY = ANTIGRAVITY_ENDPOINT_DAILY;

type ModelMeta = {
    displayName?: string;
    supportsThinking?: boolean;
    maxOutputTokens?: number;
};

/** Routes `fetch` by host so each provisioning endpoint can answer differently. */
function routeFetch(handlers: Record<string, () => Promise<unknown>>): string[] {
    const urls: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
        const target = String(url);
        urls.push(target);

        const host = Object.keys(handlers).find((candidate) => target.startsWith(candidate));
        if (!host) {
            throw new Error(`unexpected fetch to ${target}`);
        }
        return handlers[host]();
    }));

    return urls;
}

function okResponse(models: Record<string, ModelMeta>): unknown {
    return {ok: true, status: 200, json: async () => ({models})};
}

beforeEach(() => {
    vi.unstubAllGlobals();
    clearCatalogueCache();
});

describe("fetchCatalogue", () => {
    it("unions ids across both hosts and records endpoint affinity", async () => {
        routeFetch({
            [PROD]: async () => okResponse({
                "gemini-3-flash": {maxOutputTokens: 65536},
                "claude-sonnet-4-6": {displayName: "Claude Sonnet 4.6"},
            }),
            [DAILY]: async () => okResponse({
                // Same id, weaker metadata: the first host must keep ownership.
                "gemini-3-flash": {},
                "gemini-4-hydrogen-sonar": {maxOutputTokens: 65536},
            }),
        });

        const models = await fetchCatalogue("token", "project");

        expect(models?.map((model) => model.id)).toEqual([
            "gemini-3-flash",
            "claude-sonnet-4-6",
            "gemini-4-hydrogen-sonar",
        ]);

        const flash = models!.find((model) => model.id === "gemini-3-flash");
        expect(flash?.endpoints).toEqual([PROD, DAILY]);
        expect(flash?.maxOutputTokens).toBe(65536);

        const sonar = models!.find((model) => model.id === "gemini-4-hydrogen-sonar");
        expect(sonar?.endpoints).toEqual([DAILY]);
    });

    it("never truncates the catalogue when one host fails", async () => {
        routeFetch({
            [PROD]: async () => {
                throw new Error("ETIMEDOUT");
            },
            [DAILY]: async () => okResponse({
                "gemini-3.8-flash-high": {maxOutputTokens: 65536},
                "claude-opus-4-6-thinking": {supportsThinking: true},
            }),
        });

        const models = await fetchCatalogue("token", "project");

        expect(models).toHaveLength(2);
        expect(models!.every((model) => model.endpoints.length === 1)).toBe(true);
    });

    it("drops backend-internal entries that are not user-selectable", async () => {
        routeFetch({
            [PROD]: async () => okResponse({
                "gemini-3-flash": {},
                "tab_flash_lite_preview": {},
                "chat_20706": {},
                "gemini-4-carbon-disabled": {},
                "text-embedding-001": {},
            }),
            [DAILY]: async () => okResponse({}),
        });

        const models = await fetchCatalogue("token", "project");

        expect(models?.map((model) => model.id)).toEqual(["gemini-3-flash"]);
    });

    it("returns null when every host fails and nothing is cached", async () => {
        routeFetch({
            [PROD]: async () => {
                throw new Error("socket hang up");
            },
            [DAILY]: async () => ({ok: false, status: 503, json: async () => ({})}),
        });

        await expect(fetchCatalogue("token", "project")).resolves.toBeNull();
        // Resolution still has to work offline from the seed list.
        expect(knownCatalogue().length).toBeGreaterThan(1);
        expect(knownCatalogue().every((model) => model.endpoints.length === 0)).toBe(true);
    });

    it("serves the cached catalogue within TTL without refetching", async () => {
        const urls = routeFetch({
            [PROD]: async () => okResponse({"gemini-3-flash": {}}),
            [DAILY]: async () => okResponse({"gemini-4-hydrogen-sonar": {}}),
        });

        const first = await fetchCatalogue("token", "project");
        const callsAfterFirst = urls.length;
        const second = await fetchCatalogue("token", "project");

        expect(callsAfterFirst).toBe(2);
        expect(second).toBe(first);
        expect(urls).toHaveLength(callsAfterFirst);
    });
});

describe("generationEndpoints", () => {
    it("orders hosts proven to serve the id ahead of the rest", () => {
        expect(generationEndpoints({endpoints: [DAILY]})).toEqual([DAILY, PROD]);
        expect(generationEndpoints({endpoints: [PROD]})).toEqual([PROD, DAILY]);
        // Affinity gates eligibility; GENERATE_ENDPOINTS still sets priority order.
        expect(generationEndpoints({endpoints: [PROD, DAILY]})).toEqual([DAILY, PROD]);
    });

    it("falls back to every host when affinity is unknown", () => {
        expect(generationEndpoints()).toEqual([...GENERATE_ENDPOINTS]);
        expect(generationEndpoints({endpoints: []})).toEqual([...GENERATE_ENDPOINTS]);
    });
});

describe("resolveModel against a unioned catalogue", () => {
    it("reaches daily-only ids by exact id and routes aliases to capability buckets", async () => {
        routeFetch({
            [PROD]: async () => okResponse({
                "gemini-3.8-flash-high": {maxOutputTokens: 65536},
                "claude-sonnet-4-6": {},
            }),
            [DAILY]: async () => okResponse({
                "gemini-4-hydrogen-sonar": {maxOutputTokens: 65536},
                "gemini-3.1-flash-lite": {},
            }),
        });
        await fetchCatalogue("token", "project");

        const sonar = resolveModel("gemini-4-hydrogen-sonar");
        expect(sonar.id).toBe("gemini-4-hydrogen-sonar");
        expect(sonar.endpoints).toEqual([DAILY]);

        // Unknown third-party names degrade to a bucket, never to a dead id.
        expect(resolveModel("gpt-4o").id).toBe("claude-sonnet-4-6");
        expect(resolveModel("gemini-2.5-flash-lite").id).toBe("gemini-3.1-flash-lite");
    });
});
