/**
 * Built-in, in-process MCP server. It speaks real MCP over an in-memory
 * transport pair, so the proxy exercises the same client code path for it as
 * for external stdio/HTTP servers — with zero external processes and no
 * network access from tool handlers.
 */

import {createHash} from "node:crypto";

import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import type {CallToolResult} from "@modelcontextprotocol/sdk/types.js";
import {z} from "zod";

import {evaluateExpression, ExpressionError} from "./expression.js";
export const BUILTIN_SERVER_ID = "core";

const text = (value: string): CallToolResult => ({content: [{type: "text" as const, text: value}]});
const failure = (value: string): CallToolResult => ({isError: true, content: [{type: "text" as const, text: value}]});

function nowTool(timezone?: string): CallToolResult {
    const zone = timezone?.trim();
    const date = new Date();

    try {
        const local = new Intl.DateTimeFormat("en-GB", {
            dateStyle: "full",
            timeStyle: "long",
            timeZone: zone || undefined,
        }).format(date);
        return text(
            `utc_iso: ${date.toISOString()}\n` +
      `unix_millis: ${date.getTime()}\n` +
      `zone: ${zone || Intl.DateTimeFormat().resolvedOptions().timeZone}\n` +
      `local: ${local}`,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`invalid timezone: ${message}`);
    }
}

function calculateTool(expression: string): CallToolResult {
    try {
        const value = evaluateExpression(expression);
        return text(`${expression} = ${value}`);
    } catch (error) {
        if (error instanceof ExpressionError) {
            return failure(`cannot evaluate "${expression}": ${error.message}`);
        }
        const message = error instanceof Error ? error.message : String(error);
        return failure(`cannot evaluate "${expression}": ${message}`);
    }
}

function textStatsTool(input: {text: string; hash?: boolean}): CallToolResult {
    const body = input.text ?? "";
    const words = body.trim() ? body.trim().split(/\s+/).length : 0;
    const lines = body ? body.split(/\r?\n/).length : 0;
    const sentences = body.trim() ? (body.match(/[.!?]+(?=\s|$)/g)?.length ?? 0) || (body.trim() ? 1 : 0) : 0;

    const summary = [
        `characters: ${body.length}`,
        `characters_no_spaces: ${body.replace(/\s/g, "").length}`,
        `words: ${words}`,
        `lines: ${lines}`,
        `sentences: ${sentences}`,
        input.hash ? `sha256: ${createHash("sha256").update(body).digest("hex")}` : undefined,
    ]
        .filter((line): line is string => typeof line === "string")
        .join("\n");

    return text(summary);
}

/** Registers every built-in tool on a fresh MCP server instance. */
export function createBuiltinMcpServer(): McpServer {
    const server = new McpServer({name: "gemini-cli-proxy-core", version: "1.0.0"});

    server.registerTool(
        "time_now",
        {
            title: "Current time",
            description: "Returns the current date and time in ISO-8601 UTC plus a human-readable local time for an optional IANA timezone.",
            inputSchema: {
                timezone: z.string().describe("IANA timezone such as Asia/Dhaka; omit for server-local zone").optional(),
            },
        },
        async ({timezone}) => nowTool(timezone),
    );

    server.registerTool(
        "calculate",
        {
            title: "Calculator",
            description:
        "Evaluates an arithmetic expression. Supports + - * / % ^, parentheses, constants pi/e/tau and functions abs sqrt cbrt floor ceil round sin cos tan exp log log10 log2 pow min max atan2.",
            inputSchema: {
                expression: z.string().describe("Expression to evaluate, e.g. \"(2+3)*sqrt(16)/pow(2,2)\""),
            },
        },
        async ({expression}) => calculateTool(expression),
    );

    server.registerTool(
        "text_stats",
        {
            title: "Text statistics",
            description: "Counts characters, words, lines and sentences of a text block and can return its SHA-256 digest.",
            inputSchema: {
                text: z.string().describe("Text to analyse"),
                hash: z.boolean().describe("Also return the sha256 digest").optional(),
            },
        },
        async ({text: body, hash}) => textStatsTool({text: body, hash}),
    );

    return server;
}

/** Result of wiring the built-in server to a connected MCP client. */
export interface BuiltinConnection {
    client: Client;
    close(): Promise<void>;
}

/** Boots the built-in server and returns a connected MCP client for it. */
export async function connectBuiltinServer(): Promise<BuiltinConnection> {
    const server = createBuiltinMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({name: "gemini-cli-proxy-chat", version: "1.0.0"});
    await client.connect(clientTransport);

    return {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
}
