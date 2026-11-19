/**
 * Chat HTTP surface: session CRUD, MCP tool discovery and the streaming agent
 * run consumed by the bundled web UI (`/ui`).
 */

import express from "express";
import chalk from "chalk";

import type {UpstreamClient} from "../gemini/upstream-client.js";
import type {McpToolRegistry} from "../mcp/tool-registry.js";
import {getLogger} from "../utils/logger.js";

import type {ChatSessionStore} from "../chat/store.js";
import {runAgentTurn} from "../chat/agent-loop.js";
import {SseChannel} from "../chat/events.js";
import type {ChatRunRequest} from "../chat/types.js";

export interface ChatRouterDeps {
    client: UpstreamClient;
    registry: McpToolRegistry;
    store: ChatSessionStore;
}

function readString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const list = value.filter((item): item is string => typeof item === "string");
    return list.length > 0 ? list : undefined;
}

function parseRunRequest(body: unknown): ChatRunRequest | string {
    if (typeof body !== "object" || body === null) {
        return "request body must be a JSON object";
    }

    const raw = body as Record<string, unknown>;
    const model = readString(raw.model);
    if (!model) {
        return "model is required";
    }

    const message = readString(raw.message);
    if (!message) {
        return "message is required";
    }

    const effort = readString(raw.reasoningEffort);
    const request: ChatRunRequest = {
        model,
        message,
        ...(readString(raw.sessionId) ? {sessionId: readString(raw.sessionId)} : {}),
        ...(readString(raw.systemPrompt) ? {systemPrompt: readString(raw.systemPrompt)} : {}),
        ...(readStringList(raw.tools) ? {tools: readStringList(raw.tools)} : {}),
        ...(typeof raw.temperature === "number" ? {temperature: raw.temperature} : {}),
        ...(effort === "low" || effort === "medium" || effort === "high" ? {reasoningEffort: effort} : {}),
        ...(typeof raw.maxToolRounds === "number" ? {maxToolRounds: Math.floor(raw.maxToolRounds)} : {}),
    };

    return request;
}

export function createChatRouter(deps: ChatRouterDeps): express.Router {
    const router = express.Router();
    const logger = getLogger("CHAT", chalk.magenta);
    const {client, registry, store} = deps;

    router.get("/api/sessions", (_req, res) => {
        res.json({sessions: store.list()});
    });

    router.post("/api/sessions", (req, res) => {
        const body = (typeof req.body === "object" && req.body !== null ? req.body : {}) as Record<string, unknown>;
        const model = readString(body.model);
        if (!model) {
            return res.status(400).json({error: "model is required"});
        }

        const session = store.create(model, readString(body.systemPrompt));
        return res.status(201).json({session});
    });

    router.get("/api/sessions/:id", (req, res) => {
        const session = store.get(req.params.id);
        if (!session) {
            return res.status(404).json({error: "session not found"});
        }
        return res.json({session});
    });

    router.delete("/api/sessions/:id", (req, res) => {
        const removed = store.remove(req.params.id);
        if (!removed) {
            return res.status(404).json({error: "session not found"});
        }
        return res.json({ok: true});
    });

    router.get("/api/tools", (_req, res) => {
        res.json({
            servers: registry.status(),
            tools: registry.list().map((tool) => ({
                id: tool.id,
                serverId: tool.serverId,
                name: tool.name,
                description: tool.description ?? "",
            })),
        });
    });

    router.post("/api/stream", async (req, res) => {
        const parsed = parseRunRequest(req.body);
        if (typeof parsed === "string") {
            return res.status(400).json({error: parsed});
        }

        let sessionId = parsed.sessionId;
        if (sessionId && !store.get(sessionId)) {
            return res.status(404).json({error: `session "${sessionId}" not found`});
        }
        if (!sessionId) {
            sessionId = store.create(parsed.model, parsed.systemPrompt).id;
        }

        const channel = new SseChannel(res);
        const abort = new AbortController();
        res.on("close", () => {
            if (!res.writableEnded) {
                abort.abort();
            }
        });

        store.appendMessage(sessionId, {
            id: crypto.randomUUID(),
            role: "user",
            content: parsed.message ?? "",
            createdAt: new Date().toISOString(),
        });
        channel.send({type: "session", sessionId, title: store.get(sessionId)?.title ?? ""});

        logger.info(`run session=${sessionId} model=${parsed.model}`);

        try {
            await runAgentTurn(
                {client, registry, store, logger},
                {
                    sessionId,
                    model: parsed.model,
                    userText: parsed.message ?? "",
                    systemPrompt: parsed.systemPrompt,
                    tools: parsed.tools,
                    temperature: parsed.temperature,
                    reasoningEffort: parsed.reasoningEffort,
                    maxToolRounds: parsed.maxToolRounds,
                },
                (event) => channel.send(event),
                abort.signal,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`stream failed: ${message}`);
            channel.send({type: "error", message});
        } finally {
            channel.close();
        }
    });

    return router;
}
