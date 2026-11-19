/**
 * Domain types for the chat layer (sessions, transcripts, tool traces and the
 * SSE protocol spoken between the browser UI and the proxy).
 */

export type ChatRole = "user" | "assistant";

export type TraceStatus = "running" | "done" | "error";

/** One MCP tool invocation rendered inside an assistant turn. */
export interface ToolTrace {
    /** OpenAI-style call id returned by the upstream model. */
    id: string;
    /** Namespaced registry id of the tool (`server__tool`). */
    toolId: string;
    serverId: string;
    /** Raw tool name on its MCP server. */
    name: string;
    arguments: unknown;
    status: TraceStatus;
    /** Upstream reasoning signature echoed back when the call is replayed. */
    signature?: string;
    output?: string;
    error?: string;
    startedAt: number;
    endedAt?: number;
}

/** A persisted chat message. Tool activity is nested in assistant turns. */
export interface ChatMessageRecord {
    id: string;
    role: ChatRole;
    content: string;
    /** Reasoning/thinking text emitted by thinking tiers. */
    thought?: string;
    traces?: ToolTrace[];
    model?: string;
    createdAt: string;
}

export interface ChatSession {
    id: string;
    title: string;
    model: string;
    systemPrompt?: string;
    messages: ChatMessageRecord[];
    createdAt: string;
    updatedAt: string;
}

/** Lightweight projection used by the session list endpoint. */
export interface ChatSessionSummary {
    id: string;
    title: string;
    model: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface ChatRunRequest {
    sessionId?: string;
    /** New user turn. Ignored when `messages` is supplied by an API client. */
    message?: string;
    model: string;
    systemPrompt?: string;
    /** Namespaced tool ids the run may expose to the model. Empty disables tools. */
    tools?: string[];
    temperature?: number;
    reasoningEffort?: "low" | "medium" | "high";
    /** Upper bound on model→tool→model round trips. */
    maxToolRounds?: number;
}

export type ChatStreamEvent =
    | {type: "session"; sessionId: string; title: string}
    | {type: "round"; round: number}
    | {type: "token"; text: string}
    | {type: "thought"; text: string}
    | {type: "tool_start"; trace: ToolTrace}
    | {type: "tool_end"; trace: ToolTrace}
    | {type: "message"; message: ChatMessageRecord}
    | {type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number}
    | {type: "error"; message: string; retriable?: boolean}
    | {type: "done"; sessionId: string};
