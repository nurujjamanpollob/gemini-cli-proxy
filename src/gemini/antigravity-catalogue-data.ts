/**
 * Static policy data for the Antigravity model catalogue.
 *
 * The backend rewrites its ids between releases and reports unreliable
 * `displayName` values, so nothing here is authoritative at request time:
 * `antigravity-catalogue.ts` unions the live `fetchAvailableModels` answers and
 * this module only supplies the offline seed plus the capability buckets that
 * caller-supplied names are mapped onto. Ids verified 2026-11-19.
 */

export type ModelFamily = "gemini" | "claude" | "other";

/** Capability buckets callers map onto; the backend serves different ids. */
export type TierRole = "opus" | "sonnet" | "pro" | "flash" | "lite";

export interface AntigravityModel {
    id: string;
    displayName?: string;
    family: ModelFamily;
    supportsThinking: boolean;
    maxOutputTokens?: number;
    /** Hosts proven to list this id. Empty means "unknown, try every host". */
    endpoints: readonly string[];
}

export interface ResolvedModel {
    id: string;
    family: ModelFamily;
    supportsThinking: boolean;
    maxOutputTokens?: number;
    role: TierRole;
    /** Hosts proven to serve this id, carried over for endpoint affinity. */
    endpoints: readonly string[];
}

/** Catalogue TTL — the backend rewrites entitlements roughly per session. */
export const CATALOGUE_TTL_MS = 5 * 60 * 1000;

/** Seed list, used only when every `fetchAvailableModels` host is unreachable. */
export const SEED_MODEL_IDS: readonly string[] = [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-tiered",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-image",
    "gemini-3-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-thinking",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
];

/**
 * Preference order per capability bucket, strongest first. Only ids the live
 * backend serves are listed; `pickForRole` skips absent ones. Image tiers stay
 * out of every preference list so aliases never route into them by accident —
 * they remain selectable by their exact id.
 */
export const TIER_PREFERENCE: Record<TierRole, readonly string[]> = {
    opus: ["claude-opus-4-6-thinking", "claude-sonnet-4-6"],
    sonnet: ["claude-sonnet-4-6", "claude-opus-4-6-thinking"],
    pro: [
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-tiered",
        "gemini-3.8-flash-medium",
        "gemini-2.5-pro",
        // Daily-only next-generation id; last so defaults stay conservative.
        "gemini-4-hydrogen-sonar",
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
export const DEFAULT_ROLE: TierRole = "pro";

/** Client-facing names mapped onto capability buckets, not onto backend ids. */
export const ROLE_ALIASES: Record<string, TierRole> = {
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

export function familyOf(id: string): ModelFamily {
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
export function isInternalModel(id: string): boolean {
    const lower = id.toLowerCase();
    return (
        lower.startsWith("tab_") ||
        lower.startsWith("chat_") ||
        lower.endsWith("-disabled") ||
        lower.includes("embedding") ||
        lower.includes("rerank")
    );
}
