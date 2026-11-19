import {arch, platform} from "node:os";

/**
 * Wire contract for the Google Antigravity upstream (cloudcode-pa v1internal).
 * Values verified against live traffic captured by community clients
 * (antigravity-claude-proxy, CLIProxyAPI) and re-verified locally.
 */

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

/** Generation traffic: daily first, production as fallback. */
export const GENERATE_ENDPOINTS: readonly string[] = [
    ANTIGRAVITY_ENDPOINT_DAILY,
    ANTIGRAVITY_ENDPOINT_PROD,
];

/** Provisioning traffic answers faster on production. */
export const PROVISION_ENDPOINTS: readonly string[] = [
    ANTIGRAVITY_ENDPOINT_PROD,
    ANTIGRAVITY_ENDPOINT_DAILY,
];

export const API_VERSION = "v1internal";

/** `ClientMetadata.IdeType` as the protobuf backend expects raw numbers. */
export const IDE_TYPE_ANTIGRAVITY = 9;

/** `ClientMetadata.PluginType`: 0 unspecified, 1 cloud-code, 2 gemini. */
export const PLUGIN_TYPE_GEMINI = 2;

const PLATFORM_ENUM: Record<string, number> = {
    "darwin:x64": 1,
    "darwin:arm64": 2,
    "linux:x64": 3,
    "linux:arm64": 4,
    "win32:x64": 5,
};

export function platformEnum(): number {
    return PLATFORM_ENUM[`${platform()}:${arch()}`] ?? 0;
}

/** Client metadata block shared by loadCodeAssist / onboardUser / generate*. */
export function clientMetadata(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
        ideType: IDE_TYPE_ANTIGRAVITY,
        platform: platformEnum(),
        pluginType: PLUGIN_TYPE_GEMINI,
        ...extra,
    };
}

/**
 * The backend gates model visibility on the Hub user-agent family. Legacy
 * `antigravity/<version>` agents get a reduced catalogue.
 */
export const CLIENT_VERSION = process.env.ANTIGRAVITY_CLIENT_VERSION || "1.110.0";
const IDE_VERSION = process.env.ANTIGRAVITY_IDE_VERSION || "2.32.0";

function userAgent(): string {
    const osName = platform() === "darwin" ? "darwin" : platform() === "win32" ? "win32" : "linux";
    return `antigravity/hub/${IDE_VERSION} ${osName}/${arch()}`;
}

/** Base headers every Antigravity request must carry. */
export function antigravityHeaders(accept?: string): Record<string, string> {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": userAgent(),
        "X-Client-Name": "antigravity",
        "X-Client-Version": CLIENT_VERSION,
        "x-goog-api-client": "gl-node/18.18.2 fire/0.8.6 grpc/1.10.x",
    };
    if (accept) {
        headers["Accept"] = accept;
    }
    return headers;
}

/** OAuth client registered for the Antigravity suite (installed-app type). */
export const OAUTH_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const OAUTH_CLIENT_SECRET = "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";
export const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";

/** `cclog` + `experimentsandconfigs` are what unlock the Antigravity entitlement. */
export const OAUTH_SCOPES: readonly string[] = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Loopback ports; Google accepts any localhost port but the range stays stable. */
export const OAUTH_CALLBACK_PORTS: readonly number[] = (() => {
    const primary = Number.parseInt(process.env.OAUTH_CALLBACK_PORT || "51121", 10);
    const candidates = [primary, 51122, 51123, 51124, 51125, 51126];
    return [...new Set(candidates.filter((p) => Number.isInteger(p) && p > 0 && p < 65536))];
})();

/** Last-resort project when discovery and onboarding both fail. */
export const FALLBACK_PROJECT_ID = process.env.ANTIGRAVITY_FALLBACK_PROJECT || "rising-fact-p41fc";

/** Gemini output ceiling enforced by the Antigravity tier. */
export const MAX_OUTPUT_TOKENS = 65536;

/** Sentinel accepted by the backend when a thought signature is unavailable. */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
