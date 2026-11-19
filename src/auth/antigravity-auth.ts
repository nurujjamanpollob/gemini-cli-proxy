import crypto from "node:crypto";
import http from "node:http";
import readline from "node:readline";

import chalk from "chalk";
import open from "open";

import {
    OAUTH_AUTH_URL,
    OAUTH_CALLBACK_PORTS,
    OAUTH_CLIENT_ID,
    OAUTH_CLIENT_SECRET,
    OAUTH_SCOPES,
    OAUTH_TOKEN_URL,
} from "../utils/antigravity-constants.js";
import {getLogger, Logger} from "../utils/logger.js";
import {AntigravityTokenStore} from "./antigravity-token-store.js";

const CALLBACK_PATH = "/oauth-callback";
/** Human sign-in budget; override with ANTIGRAVITY_AUTH_TIMEOUT_SECONDS. */
const CALLBACK_TIMEOUT_MS =
  (Number.parseInt(process.env.ANTIGRAVITY_AUTH_TIMEOUT_SECONDS || "600", 10) || 600) * 1000;

interface PkcePair {
    verifier: string;
    challenge: string;
}

function createPkce(): PkcePair {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return {verifier, challenge};
}

function buildAuthUrl(port: number, pkce: PkcePair, state: string): string {
    const params = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: `http://localhost:${port}${CALLBACK_PATH}`,
        response_type: "code",
        scope: OAUTH_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        state,
    });
    return `${OAUTH_AUTH_URL}?${params.toString()}`;
}

async function bindCallbackServer(
    ports: readonly number[],
): Promise<{server: http.Server; port: number}> {
    const errors: string[] = [];
    for (const port of ports) {
        const server = http.createServer();
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.once("listening", () => {
                    server.removeListener("error", reject);
                    resolve();
                });
                server.listen(port, "localhost");
            });
            return {server, port};
        } catch (error) {
            errors.push(`port ${port}: ${(error as Error).message}`);
            server.removeAllListeners();
        }
    }
    throw new Error(
        `Unable to bind an OAuth callback port. Tried ${ports.join(", ")} (${errors.join("; ")}). ` +
      "Set OAUTH_CALLBACK_PORT or run with --disable-browser-auth and paste the redirect URL.",
    );
}

/** Resolves the authorization code delivered to the loopback server. */
function waitForCallback(server: http.Server, expectedState: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
            server.close();
            reject(new Error("Timed out waiting for the Antigravity OAuth callback."));
        }, CALLBACK_TIMEOUT_MS);

        server.on("request", (req, res) => {
            const requestUrl = new URL(req.url ?? "", "http://localhost");
            const respond = (status: number, title: string, body: string): void => {
                res.writeHead(status, {"Content-Type": "text/html; charset=utf-8"});
                res.end(
                    "<html><body style=\"font-family:system-ui;padding:40px;text-align:center\">" +
            `<h2>${title}</h2><p>${body}</p></body></html>`,
                );
            };

            if (requestUrl.pathname !== CALLBACK_PATH) {
                respond(404, "Not found", "Unexpected callback path.");
                return;
            }

            const error = requestUrl.searchParams.get("error");
            const code = requestUrl.searchParams.get("code");
            const state = requestUrl.searchParams.get("state");

            if (error) {
                server.close();
                clearTimeout(timer);
                respond(400, "Authentication failed", error);
                reject(new Error(`Google rejected the sign-in: ${error}`));
                return;
            }
            if (!code || state !== expectedState) {
                respond(400, "Authentication failed", "State mismatch or missing code.");
                return;
            }

            respond(200, "Antigravity linked", "Return to the terminal. You can close this tab.");
            server.close();
            clearTimeout(timer);
            resolve(code);
        });
    });
}

/** Accepts a pasted redirect URL or bare code from an attached terminal. */
async function readCodeFromTerminal(logger: Logger): Promise<string> {
    if (!process.stdin.isTTY) {
        throw new Error(
            "No browser could be opened and no interactive terminal is attached. " +
        "Start the proxy from a terminal to complete Antigravity sign-in.",
        );
    }

    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    const answer = await new Promise<string>((resolve) => {
        rl.question("Paste the full redirect URL (or just the code): ", resolve);
    });
    rl.close();

    const trimmed = answer.trim();
    if (!trimmed) {
        throw new Error("No authorization code provided.");
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        const code = new URL(trimmed).searchParams.get("code");
        if (!code) {
            throw new Error("The pasted URL contains no ?code= parameter.");
        }
        return code;
    }
    return trimmed;
}

async function exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
): Promise<{access_token?: string; refresh_token?: string; expires_in?: number}> {
    const response = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
        body: new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
            code,
            code_verifier: verifier,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
        }),
    });

    if (!response.ok) {
        throw new Error(`Antigravity token exchange failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    };
}

/**
 * Returns a token store backed by an Antigravity-scoped Google account.
 * Cached credentials win; otherwise an interactive PKCE login is performed.
 */
export async function setupAntigravityAuthentication(
    disableBrowserAuth: boolean,
): Promise<AntigravityTokenStore> {
    const logger = getLogger("AGY-AUTH", chalk.magenta);

    const cached = await AntigravityTokenStore.load();
    if (cached) {
        try {
            const email = await cached.fetchEmail();
            logger.info(`cached Antigravity credentials loaded${email ? ` for: ${email}` : ""}`);
            return cached;
        } catch (error) {
            logger.warn(`cached Antigravity credentials rejected: ${(error as Error).message}`);
            logger.info("starting a fresh Antigravity sign-in");
        }
    }

    const interactive = disableBrowserAuth || !!process.env.NO_BROWSER || !!process.env.CI;
    const pkce = createPkce();
    const state = crypto.randomBytes(16).toString("hex");

    let code: string;
    let redirectUri: string;

    if (interactive) {
        redirectUri = `http://localhost:${OAUTH_CALLBACK_PORTS[0]}${CALLBACK_PATH}`;
        logger.info("Antigravity sign-in required. Open this URL and approve the account:");
        logger.info(buildAuthUrl(OAUTH_CALLBACK_PORTS[0], pkce, state));
        code = await readCodeFromTerminal(logger);
    } else {
        const {server, port} = await bindCallbackServer(OAUTH_CALLBACK_PORTS);
        redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
        const authUrl = buildAuthUrl(port, pkce, state);

        logger.info("Antigravity sign-in required.");
        logger.info(`Opening browser, otherwise navigate to:\n${authUrl}`);
        try {
            await open(authUrl);
        } catch {
            logger.warn("Could not launch the browser automatically.");
        }
        const callback = waitForCallback(server, state);
        // Only poll the terminal when one is attached; a missing TTY must not
        // abort a perfectly healthy browser callback flow.
        const manual = process.stdin.isTTY ? readCodeFromTerminal(logger) : null;
        manual?.catch(() => undefined);

        try {
            code = await Promise.race(manual ? [callback, manual] : [callback]);
        } catch (error) {
            server.close();
            throw error;
        } finally {
            server.close();
        }
    }


    const tokens = await exchangeCode(code, pkce.verifier, redirectUri);
    if (!tokens.access_token) {
        throw new Error("Antigravity sign-in completed but no access token was returned.");
    }

    const store = new AntigravityTokenStore({});
    store.applyTokens(tokens);
    const email = await store.fetchEmail();
    await store.persist();
    logger.info(`Antigravity authentication complete${email ? ` for: ${email}` : ""}`);
    return store;
}
