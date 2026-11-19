/**
 * MCP server configuration for the proxy's tool layer.
 *
 * Resolution order:
 *   1. `--mcp-config <path>` / `MCP_CONFIG` (explicit file)
 *   2. `mcp.config.json` next to the package root
 * Absent files are not an error: the built-in in-process server still runs, so
 * tool calling works with zero external setup.
 */

import {readFileSync, existsSync} from "node:fs";
import path from "node:path";

import {getPackageRoot} from "../utils/runtime-paths.js";

export type McpTransportKind = "stdio" | "http";

export interface McpServerConfig {
    id: string;
    transport: McpTransportKind;
    /** stdio only. */
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** http only. */
    url?: string;
    headers?: Record<string, string>;
    disabled?: boolean;
    /** Whitelist of raw tool names exposed by this server. */
    includeTools?: string[];
    /** Blacklist of raw tool names hidden from the model. */
    excludeTools?: string[];
    /** Per-call timeout in milliseconds. */
    timeoutMs?: number;
}

export interface McpConfig {
    /** Start the built-in in-process MCP server (time / math / text tools). */
    builtin: boolean;
    servers: McpServerConfig[];
}

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const CONFIG_FILENAME = "mcp.config.json";

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
/** Expands `${VAR}` references from the process environment. */
export function expandEnv(value: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function readStringMap(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const entries: Array<[string, string]> = [];
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") {
            entries.push([key, expandEnv(entry)]);
        }
    }

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const list = value.filter((item): item is string => typeof item === "string").map(expandEnv);
    return list.length > 0 ? list : undefined;
}

function parseServer(id: string, raw: unknown): McpServerConfig | null {
    if (!isRecord(raw)) {
        return null;
    }

    const transport = raw.transport === "http" ? "http" : "stdio";
    const config: McpServerConfig = {id, transport};

    if (transport === "http") {
        if (typeof raw.url !== "string" || !raw.url) {
            return null;
        }
        config.url = expandEnv(raw.url);
        const headers = readStringMap(raw.headers);
        if (headers) {
            config.headers = headers;
        }
    } else {
        if (typeof raw.command !== "string" || !raw.command) {
            return null;
        }
        config.command = expandEnv(raw.command);
        const args = readStringArray(raw.args);
        if (args) {
            config.args = args;
        }
        const env = readStringMap(raw.env);
        if (env) {
            config.env = env;
        }
        if (typeof raw.cwd === "string") {
            config.cwd = expandEnv(raw.cwd);
        }
    }

    if (raw.disabled === true) {
        config.disabled = true;
    }
    const include = readStringArray(raw.includeTools);
    if (include) {
        config.includeTools = include;
    }
    const exclude = readStringArray(raw.excludeTools);
    if (exclude) {
        config.excludeTools = exclude;
    }
    if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) {
        config.timeoutMs = Math.floor(raw.timeoutMs);
    }

    return config;
}

/** Parses a raw config document, dropping malformed entries. */
export function parseMcpConfig(document: unknown): McpConfig {
    const config: McpConfig = {builtin: true, servers: []};
    if (!isRecord(document)) {
        return config;
    }

    if (document.builtin === false) {
        config.builtin = false;
    }

    const servers = document.servers;
    if (isRecord(servers)) {
        for (const [id, raw] of Object.entries(servers)) {
            const parsed = parseServer(id, raw);
            if (parsed) {
                config.servers.push(parsed);
            }
        }
    }

    return config;
}

/** Locates the config file: explicit path first, then package-root default. */
export function resolveConfigPath(explicit?: string): string | undefined {
    const candidate = explicit ?? process.env.MCP_CONFIG;
    if (candidate) {
        return path.resolve(candidate);
    }

    const fallback = path.join(getPackageRoot(), CONFIG_FILENAME);
    return existsSync(fallback) ? fallback : undefined;
}

/** Loads MCP configuration; never throws, degrading to built-in-only. */
export function loadMcpConfig(explicit?: string): {config: McpConfig; path?: string; error?: string} {
    if (process.env.MCP_DISABLED === "1") {
        return {config: {builtin: false, servers: []}};
    }

    const filePath = resolveConfigPath(explicit);
    if (!filePath) {
        return {config: {builtin: process.env.MCP_BUILTIN_DISABLED !== "1", servers: []}};
    }

    try {
        const parsed = parseMcpConfig(JSON.parse(readFileSync(filePath, "utf8")));
        if (process.env.MCP_BUILTIN_DISABLED === "1") {
            parsed.builtin = false;
        }
        return {config: parsed, path: filePath};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {config: {builtin: process.env.MCP_BUILTIN_DISABLED !== "1", servers: []}, path: filePath, error: message};
    }
}
