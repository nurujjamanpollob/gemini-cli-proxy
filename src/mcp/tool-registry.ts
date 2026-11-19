/**
 * Aggregates tools from every connected MCP server behind one OpenAI-style
 * function-call surface. Tool names are namespaced (`server__tool`) and
 * sanitised so they satisfy the OpenAI/Gemini function-name grammar; the
 * registry keeps the mapping back to the real server + tool name.
 */

import crypto from "node:crypto";
import type {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {CallToolResultSchema} from "@modelcontextprotocol/sdk/types.js";
import type {CallToolResult, ContentBlock, Tool as McpTool} from "@modelcontextprotocol/sdk/types.js";

import type {McpConfig, McpServerConfig, McpTransportKind} from "./config.js";
import {DEFAULT_CALL_TIMEOUT_MS} from "./config.js";
import {connectServer, type McpConnection} from "./connect.js";
import {BUILTIN_SERVER_ID, connectBuiltinServer} from "./builtin-server.js";
import type * as OpenAI from "../types/openai.js";
import type {Logger} from "../utils/logger.js";

const MAX_TOOL_NAME_LENGTH = 64;
/** Model-side hard cap on function names; longer ids are hashed into the tail. */
const HASH_LENGTH = 8;

export interface RegistryTool {
    /** Namespaced, model-visible id (`server__tool`). */
    id: string;
    serverId: string;
    /** Raw tool name as published by its MCP server. */
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
}

export type ServerState = "connected" | "failed" | "disabled";

export interface ServerStatus {
    id: string;
    transport: McpTransportKind | "inprocess";
    state: ServerState;
    toolCount: number;
    tools: string[];
    error?: string;
}

export interface CallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** Collapses MCP content blocks into plain text for the model. */
export function flattenToolResult(result: CallToolResult): string {
    const blocks = result.content ?? [];
    const parts: string[] = [];

    for (const block of blocks) {
        const loose = block as ContentBlock & Record<string, unknown>;
        switch (loose.type) {
            case "text":
                parts.push(typeof loose.text === "string" ? loose.text : "");
                break;
            case "image":
            case "audio":
                parts.push(`[${loose.type} ${typeof loose.mimeType === "string" ? loose.mimeType : "unknown"}]`);
                break;
            case "resource_link":
                parts.push(`[link ${String(loose.name ?? "")} ${String(loose.uri ?? "")}]`.trim());
                break;
            case "resource": {
                const resource = loose.resource as Record<string, unknown> | undefined;
                const textValue = (resource?.text as string) ?? undefined;
                parts.push(textValue ?? `[resource ${String(resource?.uri ?? "")}]`);
                break;
            }
            default:
                parts.push(JSON.stringify(loose));
        }
    }

    if (parts.length === 0 && result.structuredContent) {
        parts.push(JSON.stringify(result.structuredContent, null, 2));
    }

    return parts.join("\n").trim();
}

function sanitizeSegment(value: string): string {
    const cleaned = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+/, "");
    return cleaned || "x";
}

/** Builds a model-safe namespaced tool id. */
export function makeToolId(serverId: string, toolName: string): string {
    const raw = `${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
    if (raw.length <= MAX_TOOL_NAME_LENGTH) {
        return raw;
    }

    const digest = crypto.createHash("sha1").update(`${serverId}/${toolName}`).digest("hex").slice(0, HASH_LENGTH);
    return `${raw.slice(0, MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1)}_${digest}`;
}

function isToolVisible(config: McpServerConfig | undefined, toolName: string): boolean {
    if (!config) {
        return true;
    }
    if (config.includeTools && !config.includeTools.includes(toolName)) {
        return false;
    }
    return !config.excludeTools?.includes(toolName);
}

export class McpToolRegistry {
    private readonly connections = new Map<string, McpConnection>();
    private readonly configs = new Map<string, McpServerConfig | undefined>();
    private readonly toolsById = new Map<string, RegistryTool>();
    private readonly statuses = new Map<string, ServerStatus>();

    private constructor(private readonly logger: Logger) {}

    /** Connects every configured server; failures are recorded, never fatal. */
    static async create(config: McpConfig, logger: Logger): Promise<McpToolRegistry> {
        const registry = new McpToolRegistry(logger);

        if (config.builtin) {
            await registry.attachBuiltin();
        }

        for (const server of config.servers) {
            await registry.attach(server);
        }

        logger.info(`mcp: ${registry.toolsById.size} tool(s) from ${registry.connections.size} server(s)`);
        return registry;
    }

    /** A registry with no servers, used when tools are disabled entirely. */
    static empty(logger: Logger): McpToolRegistry {
        return new McpToolRegistry(logger);
    }

    private async attachBuiltin(): Promise<void> {
        try {
            const connection = await connectBuiltinServer();
            this.connections.set(BUILTIN_SERVER_ID, {client: connection.client, close: connection.close});
            this.configs.set(BUILTIN_SERVER_ID, undefined);
            await this.indexServer(BUILTIN_SERVER_ID, "inprocess", connection.client, undefined);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.statuses.set(BUILTIN_SERVER_ID, {id: BUILTIN_SERVER_ID, transport: "inprocess", state: "failed", toolCount: 0, tools: [], error: message});
            this.logger.warn(`builtin mcp server failed: ${message}`);
        }
    }

    private async attach(server: McpServerConfig): Promise<void> {
        if (server.disabled) {
            this.statuses.set(server.id, {id: server.id, transport: server.transport, state: "disabled", toolCount: 0, tools: []});
            return;
        }

        try {
            const connection = await connectServer(server, this.logger);
            this.connections.set(server.id, connection);
            this.configs.set(server.id, server);
            await this.indexServer(server.id, server.transport, connection.client, server);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.statuses.set(server.id, {id: server.id, transport: server.transport, state: "failed", toolCount: 0, tools: [], error: message});
        }
    }

    private async indexServer(id: string, transport: ServerStatus["transport"], client: Client, config?: McpServerConfig): Promise<void> {
        const listed = await client.listTools(undefined, {timeout: CONNECT_LIST_TIMEOUT_MS});
        const tools: McpTool[] = listed.tools ?? [];
        const visible: string[] = [];

        for (const tool of tools) {
            if (!isToolVisible(config, tool.name)) {
                continue;
            }

            let toolId = makeToolId(id, tool.name);
            for (let suffix = 2; this.toolsById.has(toolId); suffix++) {
                toolId = `${makeToolId(id, tool.name)}_${suffix}`.slice(0, MAX_TOOL_NAME_LENGTH);
            }
            this.toolsById.set(toolId, {
                id: toolId,
                serverId: id,
                name: tool.name,
                description: tool.description,
                inputSchema: (tool.inputSchema ?? {type: "object", properties: {}}) as Record<string, unknown>,
            });
            visible.push(tool.name);
        }

        this.statuses.set(id, {id, transport, state: "connected", toolCount: visible.length, tools: visible});
    }

    list(): RegistryTool[] {
        return [...this.toolsById.values()].sort((left, right) => left.id.localeCompare(right.id));
    }

    /** Projects registry tools into OpenAI function tools for the model. */
    openAiTools(enabledIds?: string[]): OpenAI.Tool[] {
        const enabled = enabledIds && enabledIds.length > 0 ? new Set(enabledIds) : undefined;

        return this.list()
            .filter((tool) => !enabled || enabled.has(tool.id))
            .map((tool) => ({
                type: "function" as const,
                function: {
                    name: tool.id,
                    description: tool.description ?? `${tool.serverId} MCP tool ${tool.name}`,
                    parameters: tool.inputSchema,
                },
            }));
    }

    status(): ServerStatus[] {
        return [...this.statuses.values()].sort((left, right) => left.id.localeCompare(right.id));
    }

    size(): number {
        return this.toolsById.size;
    }

    /** Resolves a model-supplied tool id, tolerating case/formatting drift. */
    private resolve(toolId: string): RegistryTool | undefined {
        const exact = this.toolsById.get(toolId);
        if (exact) {
            return exact;
        }
        const lowered = toolId.toLowerCase();
        for (const tool of this.toolsById.values()) {
            if (tool.id.toLowerCase() === lowered || `${tool.serverId}__${tool.name}`.toLowerCase() === lowered) {
                return tool;
            }
        }
        return undefined;
    }

    /** Executes a tool and returns its textual result. */
    async call(toolId: string, rawArguments: string | unknown, options: CallOptions = {}): Promise<string> {
        const tool = this.resolve(toolId);
        if (!tool) {
            throw new Error(`unknown tool "${toolId}"`);
        }

        const connection = this.connections.get(tool.serverId);
        if (!connection) {
            throw new Error(`mcp server "${tool.serverId}" is not connected`);
        }
        const args = parseArguments(rawArguments);
        const timeoutMs = options.timeoutMs ?? this.configs.get(tool.serverId)?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

        const result = (await connection.client.callTool(
            {name: tool.name, arguments: args},
            CallToolResultSchema,
            {signal: combineSignals(options.signal, timeoutMs)},
        )) as CallToolResult;

        const text = flattenToolResult(result);
        if (result.isError) {
            throw new Error(text || `tool "${tool.id}" reported an error`);
        }
        return text || "(empty result)";
    }

    async closeAll(): Promise<void> {
        for (const [id, connection] of this.connections) {
            await connection.close().catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`failed to close mcp server "${id}": ${message}`);
            });
        }
        this.connections.clear();
        this.toolsById.clear();
    }
}

const CONNECT_LIST_TIMEOUT_MS = Number(process.env.MCP_LIST_TIMEOUT_MS ?? 15_000);

function parseArguments(raw: string | unknown): Record<string, unknown> {
    if (raw === undefined || raw === null || raw === "") {
        return {};
    }
    if (typeof raw === "string") {
        try {
            const parsed: unknown = JSON.parse(raw);
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {value: parsed};
        } catch {
            return {text: raw};
        }
    }
    if (typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    return {value: raw};
}

/** Combines a caller signal with a per-call timeout. */
function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (!signal) {
        return timeout;
    }
    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any([signal, timeout]);
    }
    return signal.aborted ? signal : timeout;
}
