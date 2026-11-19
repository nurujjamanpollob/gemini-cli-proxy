#!/usr/bin/env node
import express from "express";
import {Command} from "@commander-js/extra-typings";
import cors from "cors";

import {setupAuthentication} from "./auth/auth.js";
import {setupAntigravityAuthentication} from "./auth/antigravity-auth.js";
import {GeminiApiClient} from "./gemini/client.js";
import {AntigravityClient} from "./gemini/antigravity-client.js";
import type {UpstreamClient} from "./gemini/upstream-client.js";
import {createOpenAIRouter} from "./routes/openai.js";
import {createAnthropicRouter} from "./routes/anthropic.js";
import {createChatRouter} from "./routes/chat.js";
import {ChatSessionStore} from "./chat/store.js";
import {loadMcpConfig} from "./mcp/config.js";
import {McpToolRegistry} from "./mcp/tool-registry.js";
import {getStaticUiDir} from "./utils/runtime-paths.js";
import {
    DEFAULT_PORT,
    DISABLE_AUTO_MODEL_SWITCH,
    DISABLE_BROWSER_AUTH,
    DISABLE_GOOGLE_SEARCH
} from "./utils/constant.js";
import {getLogger} from "./utils/logger.js";
import chalk from "chalk";

type UpstreamName = "antigravity" | "code-assist";

const DEFAULT_UPSTREAM: UpstreamName =
    (process.env.UPSTREAM_PROVIDER as UpstreamName) === "code-assist" ? "code-assist" : "antigravity";

const program = new Command()
    .option("-p, --port <port>", "Server port", DEFAULT_PORT)
    .option("-g --google-cloud-project <googleCloudProject>", process.env.GOOGLE_CLOUD_PROJECT)
    .option("--upstream <provider>", "Upstream entitlement: antigravity | code-assist", DEFAULT_UPSTREAM)
    .option("--disable-browser-auth", "Disables browser auth flow and uses code based auth", DISABLE_BROWSER_AUTH)
    .option("--disable-google-search", "Disables native Google Search tool", DISABLE_GOOGLE_SEARCH)
    .option("--disable-auto-model-switch", "Disables auto model switching in case of rate limiting", DISABLE_AUTO_MODEL_SWITCH)
    .option("--mcp-config <path>", "Path to an MCP config file (env: MCP_CONFIG)")
    .option("--disable-mcp", "Disables the MCP tool layer and the chat tool loop")
    .parse(process.argv);

const opts = program.opts();

/** Builds the upstream client selected on the command line. */
async function createUpstreamClient(logger: ReturnType<typeof getLogger>): Promise<UpstreamClient> {
    const project = opts.googleCloudProject ?? process.env.GOOGLE_CLOUD_PROJECT;

    if (opts.upstream === "code-assist") {
        logger.info("upstream: Google Code Assist (Gemini CLI quota)");
        const authClient = await setupAuthentication(opts.disableBrowserAuth ?? false);
        return new GeminiApiClient(
            authClient,
            project,
            opts.disableAutoModelSwitch
        );
    }

    logger.info("upstream: Antigravity (cloudcode-pa entitlement quota)");
    const tokens = await setupAntigravityAuthentication(opts.disableBrowserAuth ?? false);
    return new AntigravityClient(tokens, project);
}

/** Connects the MCP tool layer; never fatal — tools simply stay unavailable. */
async function createToolRegistry(logger: ReturnType<typeof getLogger>): Promise<McpToolRegistry> {
    if (opts.disableMcp) {
        logger.info("mcp: disabled by --disable-mcp");
        return McpToolRegistry.empty(logger);
    }

    const {config, path, error} = loadMcpConfig(opts.mcpConfig);
    if (error) {
        logger.warn(`mcp config at ${path} is invalid (${error}); using built-in tools only`);
    } else if (path) {
        logger.info(`mcp config: ${path}`);
    }

    return McpToolRegistry.create(config, logger);
}

export async function startServer() {
    const logger = getLogger("SERVER", chalk.green);
    logger.info("starting server...");

    try {
        const geminiClient = await createUpstreamClient(logger);
        const registry = await createToolRegistry(logger);
        const sessionStore = new ChatSessionStore();

        const app = express();

        // Enable CORS
        app.use(cors());

        // Add request logging middleware
        app.use((req, res, next) => {
            logger.info(`${new Date().toISOString()} - ${req.method} ${req.url}`);
            next();
        });

        // Custom JSON parsing with better error handling
        app.use((req, res, next) => {
            if (req.headers["content-type"]?.includes("application/json")) {
                let body = "";
                req.on("data", chunk => {
                    body += chunk.toString();
                });
                req.on("end", () => {
                    try {
                        if (body) {
                            req.body = JSON.parse(body);
                        }
                        next();
                    } catch (err) {
                        if (err instanceof Error) {
                            logger.error(`json parse error: ${err.message}`);
                            res.status(400).json({
                                error: "Invalid JSON in request body",
                                details: err.message,
                                position: body.length > 0 ? Math.min(500, body.length) : 0
                            });
                        } else {
                            logger.error(err as string);
                        }
                    }
                });
            } else {
                next();
            }
        });

        const uiDir = getStaticUiDir();

        app.get("/", (_req, res) => {
            if (uiDir) {
                return res.redirect("/ui");
            }
            return res.type("text/plain").send(
                "Available endpoints:\n" +
                `* Chat UI: http://localhost:${opts.port}/ui\n` +
                `* OpenAI compatible endpoint: http://localhost:${opts.port}/openai\n` +
                `* Anthropic compatible endpoint: http://localhost:${opts.port}/anthropic`
            );
        });

        app.get("/health", (_req, res) => {
            res.status(200).json({status: "ok"});
        });

        // Bundled chat UI (static assets only; API lives under /chat/api).
        if (uiDir) {
            app.use("/ui", express.static(uiDir, {index: ["index.html"], extensions: false}));
        }

        const openAIRouter = createOpenAIRouter(geminiClient);
        app.use("/openai", openAIRouter);

        const anthropicRouter = createAnthropicRouter(geminiClient);
        app.use("/anthropic", anthropicRouter);

        const chatRouter = createChatRouter({client: geminiClient, registry, store: sessionStore});
        app.use("/chat", chatRouter);

        // 6. Start server
        const server = app.listen(opts.port, () => {
            logger.info("server started");
            if (uiDir) {
                logger.info(`Chat UI: http://localhost:${opts.port}/ui`);
            }
            logger.info(`OpenAI compatible endpoint: http://localhost:${opts.port}/openai`);
            logger.info(`Anthropic compatible endpoint: http://localhost:${opts.port}/anthropic`);
            logger.info("press Ctrl+C to stop the server");
        });

        // Handle graceful shutdown
        let isShuttingDown = false;
        const gracefulShutdown = (signal: string) => {
            if (isShuttingDown) return;
            isShuttingDown = true;
            
            logger.info(`\n${signal} received. Shutting down gracefully...`);
            server.close(() => {
                registry.closeAll()
                    .catch(() => undefined)
                    .finally(() => {
                        logger.info("Server closed.");
                        process.exit(0);
                    });
            });
        };

        process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
        process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    } catch (err) {
        if (err instanceof Error) {
            logger.error(err.message);
        } else {
            logger.error(err as string);
        }

        process.exit(1);
    }
}

startServer();
