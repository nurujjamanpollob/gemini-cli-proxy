import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_TOKEN_URL,
    OAUTH_USERINFO_URL,
} from "../utils/antigravity-constants.js";
import { getLogger } from "../utils/logger.js";
import chalk from "chalk";

const CREDENTIAL_FILENAME = "antigravity_oauth_creds.json";
/** Refresh this early so a token never expires mid-request. */
const EXPIRY_SKEW_MS = 60_000;

export interface AntigravityCredential {
    access_token?: string;
    refresh_token?: string;
    /** Absolute expiry as epoch milliseconds. */
    expiry_date?: number;
    email?: string;
    project_id?: string | null;
}

export function antigravityCredentialPath(): string {
    return path.join(os.homedir(), ".gemini", CREDENTIAL_FILENAME);
}

/**
 * Owns the Antigravity OAuth token pair: persistence, refresh and identity.
 * Kept in a file separate from `oauth_creds.json` so the Code Assist flow is
 * never disturbed by switching upstreams.
 */
export class AntigravityTokenStore {
    private readonly logger = getLogger("AGY-AUTH", chalk.magenta);
    private refreshInFlight: Promise<string> | null = null;

    constructor(private credential: AntigravityCredential) {}

    static async load(): Promise<AntigravityTokenStore | null> {
        try {
            const raw = await fs.readFile(antigravityCredentialPath(), "utf-8");
            const parsed = JSON.parse(raw) as AntigravityCredential;
            if (!parsed.refresh_token && !parsed.access_token) {
                return null;
            }
            return new AntigravityTokenStore(parsed);
        } catch {
            return null;
        }
    }

    get email(): string | undefined {
        return this.credential.email;
    }

    get projectId(): string | null | undefined {
        return this.credential.project_id;
    }

    setProject(projectId: string): void {
        if (this.credential.project_id === projectId) {
            return;
        }
        this.credential.project_id = projectId;
        void this.persist();
    }

    applyTokens(tokens: {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    }): void {
        this.credential.access_token = tokens.access_token;
        if (tokens.refresh_token) {
            this.credential.refresh_token = tokens.refresh_token;
        }
        this.credential.expiry_date =
      typeof tokens.expires_in === "number"
          ? Date.now() + tokens.expires_in * 1000
          : undefined;
        void this.persist();
    }

    setEmail(email: string): void {
        if (this.credential.email === email) {
            return;
        }
        this.credential.email = email;
        void this.persist();
    }

    /** Returns a valid access token, refreshing exactly once per expiry window. */
    async getAccessToken(): Promise<string> {
        const { access_token: accessToken, expiry_date: expiry } = this.credential;
        if (accessToken && (!expiry || expiry - EXPIRY_SKEW_MS > Date.now())) {
            return accessToken;
        }

        if (this.refreshInFlight) {
            return this.refreshInFlight;
        }

        this.refreshInFlight = this.refresh().finally(() => {
            this.refreshInFlight = null;
        });
        return this.refreshInFlight;
    }

    /** Drops the cached access token so the next call forces a refresh. */
    invalidateAccessToken(): void {
        this.credential.access_token = undefined;
        this.credential.expiry_date = undefined;
    }

    private async refresh(): Promise<string> {
        const refreshToken = this.credential.refresh_token;
        if (!refreshToken) {
            throw new Error(
                "No Antigravity refresh token cached. Re-run the proxy and complete sign-in.",
            );
        }

        const response = await fetch(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: OAUTH_CLIENT_ID,
                client_secret: OAUTH_CLIENT_SECRET,
                refresh_token: refreshToken,
                grant_type: "refresh_token",
            }),
        });

        if (!response.ok) {
            const detail = await response.text();
            throw new Error(
                `Antigravity token refresh failed (${response.status}): ${detail}. Delete ~/.gemini/${CREDENTIAL_FILENAME} and sign in again.`,
            );
        }

        const tokens = (await response.json()) as {
            access_token?: string;
            expires_in?: number;
        };
        if (!tokens.access_token) {
            throw new Error("Antigravity token refresh returned no access token.");
        }

        this.credential.access_token = tokens.access_token;
        this.credential.expiry_date =
      typeof tokens.expires_in === "number"
          ? Date.now() + tokens.expires_in * 1000
          : undefined;
        await this.persist();
        this.logger.debug("Antigravity access token refreshed");
        return tokens.access_token;
    }

    /** Resolves the account email for the current token. */
    async fetchEmail(): Promise<string | undefined> {
        const accessToken = await this.getAccessToken();
        try {
            const response = await fetch(OAUTH_USERINFO_URL, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (!response.ok) {
                this.logger.warn(`userinfo lookup failed with ${response.status}`);
                return this.credential.email;
            }
            const info = (await response.json()) as { email?: string };
            if (info.email) {
                this.setEmail(info.email);
            }
            return info.email;
        } catch (error) {
            this.logger.warn(`userinfo lookup error: ${(error as Error).message}`);
            return this.credential.email;
        }
    }

    async persist(): Promise<void> {
        const filePath = antigravityCredentialPath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(this.credential, null, 2), {
            mode: 0o600,
        });
    }
}

export async function clearAntigravityCredential(): Promise<void> {
    await fs.rm(antigravityCredentialPath(), { force: true });
}
