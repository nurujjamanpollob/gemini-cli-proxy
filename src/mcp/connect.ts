/**
 * Opens MCP connections for configured servers. Two transports are supported:
 * `stdio` (spawn a local MCP process, e.g. an npx-published server) and
 * `http` (Streamable HTTP endpoint). The built-in in-process server is wired in
 * `builtin-server.ts` and shares the same client type.
 */

import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport, getDefaultEnvironment} from "@modelcontextprotocol/sdk/client/stdio.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type {McpServerConfig} from "./config.js";
import type {Logger} from "../utils/logger.js";

export const CLIENT_INFO = {name: "gemini-cli-proxy-chat", version: "1.0.0"} as const;

/** Time budget for the handshake + initial tool listing. */
export const CONNECT_TIMEOUT_MS = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? 25_000);

export interface McpConnection {
    client: Client;
    close(): Promise<void>;
}

async function withTimeout<T>(task: Promise<T>, label: string, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
        return await Promise.race([task, guard]);
    } finally {
        clearTimeout(timer);
    }
}

function buildStdioTransport(config: McpServerConfig): StdioClientTransport {
    const transport = new StdioClientTransport({
        command: config.command ?? "",
        args: config.args ?? [],
        cwd: config.cwd,
        env: {...getDefaultEnvironment(), ...(config.env ?? {})},
        stderr: "pipe",
    });

    const stream = transport.stderr;
    if (stream) {
        stream.on("data", (buffer: Buffer) => {
            const line = buffer.toString().trim();
            if (line) {
                console.info(`[mcp:${config.id}] ${line}`);
            }
        });
    }

    return transport;
}

function buildHttpTransport(config: McpServerConfig): StreamableHTTPClientTransport {
    if (!config.url) {
        throw new Error(`mcp server "${config.id}" has no url`);
    }

    const requestInit = config.headers && Object.keys(config.headers).length > 0 ? {headers: config.headers} : undefined;
    return new StreamableHTTPClientTransport(new URL(config.url), {requestInit});
}

/** Connects one server and returns its client plus a close handle. */
export async function connectServer(config: McpServerConfig, logger: Logger): Promise<McpConnection> {
    const transport = config.transport === "http" ? buildHttpTransport(config) : buildStdioTransport(config);
    const client = new Client(CLIENT_INFO);

    try {
        await withTimeout(client.connect(transport), `mcp handshake for "${config.id}"`, CONNECT_TIMEOUT_MS);
    } catch (error) {
        await transport.close().catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`mcp server "${config.id}" unavailable: ${message}`);
        throw new Error(message);
    }

    return {client, close: () => client.close()};
}
