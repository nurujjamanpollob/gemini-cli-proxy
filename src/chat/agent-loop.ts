/**
 * Chat agent loop: streams an assistant turn from the upstream model, executes
 * any MCP tool calls it requests, feeds the results back and continues until the
 * model answers without tools (or the round budget is exhausted).
 */

import crypto from "node:crypto";

import * as OpenAI from "../types/openai.js";
import type {UpstreamClient} from "../gemini/upstream-client.js";
import {mapOpenAIChatCompletionRequestToGemini} from "../gemini/openai-mapper.js";
import type {McpToolRegistry} from "../mcp/tool-registry.js";
import type {Logger} from "../utils/logger.js";

import type {ChatSessionStore} from "./store.js";
import {toOpenAiMessages, trimHistory} from "./history.js";
import type {ChatMessageRecord, ChatStreamEvent, ToolTrace} from "./types.js";

export const DEFAULT_MAX_TOOL_ROUNDS = 6;

/** Maps chat-level reasoning effort names onto the mapper enum. */
const REASONING_EFFORT: Record<string, OpenAI.ReasoningEffort> = {
    low: OpenAI.ReasoningEffort.low,
    medium: OpenAI.ReasoningEffort.medium,
    high: OpenAI.ReasoningEffort.high,
};
const MAX_ERROR_LENGTH = 400;

export interface AgentLoopDeps {
    client: UpstreamClient;
    registry: McpToolRegistry;
    store: ChatSessionStore;
    logger: Logger;
}

function errorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.length > MAX_ERROR_LENGTH ? `${raw.slice(0, MAX_ERROR_LENGTH)}...` : raw;
}

function newId(): string {
    return crypto.randomUUID();
}

/** Adds the session system prompt in front of the conversation. */
function withSystemPrompt(messages: OpenAI.ChatMessage[], systemPrompt?: string): OpenAI.ChatMessage[] {
    const trimmed = systemPrompt?.trim();
    if (!trimmed) {
        return messages;
    }
    return [{role: "system", content: trimmed}, ...messages];
}

/** Streams one model turn, forwarding text/thought deltas and collecting tool calls. */
async function streamTurn(
    deps: AgentLoopDeps,
    request: Parameters<UpstreamClient["streamContent"]>[0],
    emit: (event: ChatStreamEvent) => void,
): Promise<{text: string; thought: string; calls: OpenAI.ToolCall[]; usage?: OpenAI.UsageData}> {
    let text = "";
    let thought = "";
    const calls: OpenAI.ToolCall[] = [];
    let usage: OpenAI.UsageData | undefined;

    for await (const chunk of deps.client.streamContent(request)) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta as (OpenAI.StreamDelta & Record<string, unknown>) | undefined;

        if (delta) {
            if (typeof delta.content === "string" && delta.content.length > 0) {
                if (delta._thought === true) {
                    thought += delta.content;
                    emit({type: "thought", text: delta.content});
                } else {
                    text += delta.content;
                    emit({type: "token", text: delta.content});
                }
            }

            for (const call of delta.tool_calls ?? []) {
                calls.push(call);
            }
        }

        if (chunk.usage) {
            usage = chunk.usage;
        }
    }

    return {text, thought, calls, usage};
}

function sumUsage(total: OpenAI.UsageData | undefined, next: OpenAI.UsageData | undefined): OpenAI.UsageData | undefined {
    if (!next) {
        return total;
    }
    if (!total) {
        return {...next};
    }
    return {
        prompt_tokens: total.prompt_tokens + next.prompt_tokens,
        completion_tokens: total.completion_tokens + next.completion_tokens,
        total_tokens: total.total_tokens + next.total_tokens,
    };
}

/** Executes one tool call, streams its lifecycle events and returns the settled trace. */
export async function executeToolCall(
    registry: McpToolRegistry,
    call: OpenAI.ToolCall,
    emit: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
): Promise<ToolTrace> {
    const [serverId, ...rest] = call.function.name.split("__");
    const trace: ToolTrace = {
        id: call.id,
        toolId: call.function.name,
        serverId: rest.length > 0 ? serverId : "core",
        name: rest.length > 0 ? rest.join("__") : call.function.name,
        arguments: safeParseArguments(call.function.arguments),
        status: "running",
        startedAt: Date.now(),
        ...(call._thoughtSignature ? {signature: call._thoughtSignature} : {}),
    };
    emit({type: "tool_start", trace});

    const settled: ToolTrace = await registry.call(trace.toolId, call.function.arguments, {signal})
        .then((output) => ({...trace, status: "done" as const, output: truncate(output), endedAt: Date.now()}))
        .catch((error: unknown) => ({...trace, status: "error" as const, error: errorMessage(error), endedAt: Date.now()}));

    emit({type: "tool_end", trace: settled});
    return settled;
}

function truncate(value: string): string {
    const limit = 8000;
    return value.length > limit ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]` : value;
}

function safeParseArguments(raw: string): unknown {
    try {
        return JSON.parse(raw || "{}") as unknown;
    } catch {
        return raw ? {raw} : {};
    }
}

/**
 * Runs one chat turn end-to-end and streams protocol events through `emit`.
 * The caller owns session creation for brand-new conversations.
 */
export async function runAgentTurn(
    deps: AgentLoopDeps,
    params: {
        sessionId: string;
        model: string;
        userText: string;
        systemPrompt?: string;
        tools?: string[];
        temperature?: number;
        reasoningEffort?: "low" | "medium" | "high";
        maxToolRounds?: number;
    },
    emit: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const session = deps.store.get(params.sessionId);
    if (!session) {
        emit({type: "error", message: `session "${params.sessionId}" not found`});
        return;
    }

    const history = trimHistory(session.messages);
    const working: OpenAI.ChatMessage[] = toOpenAiMessages(history);
    working.push({role: "user", content: params.userText});

    const tools = deps.registry.openAiTools(params.tools && params.tools.length > 0 ? params.tools : undefined);
    const maxRounds = Math.max(1, Math.min(params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS, 12));
    const traces: ToolTrace[] = [];

    let assistantText = "";
    let assistantThought = "";
    let usage: OpenAI.UsageData | undefined;

    try {
        const project = await deps.client.discoverProjectId();

        for (let round = 1; round <= maxRounds; round++) {
            if (signal?.aborted) {
                break;
            }
            emit({type: "round", round});

            const completionRequest = mapOpenAIChatCompletionRequestToGemini(project, {
                model: params.model,
                messages: withSystemPrompt(working, params.systemPrompt ?? session.systemPrompt),
                temperature: params.temperature,
                ...(params.reasoningEffort ? {reasoning_effort: REASONING_EFFORT[params.reasoningEffort]} : {}),
                stream: true,
                ...(tools.length > 0 ? {tools} : {}),
            });

            const turn = await streamTurn(deps, completionRequest, emit);
            assistantText += turn.text;
            assistantThought += turn.thought;
            usage = sumUsage(usage, turn.usage);

            if (turn.calls.length === 0) {
                break;
            }

            if (round === maxRounds) {
                emit({type: "error", message: `tool round limit (${maxRounds}) reached before a final answer`});
                break;
            }

            working.push({role: "assistant", content: turn.text || "", tool_calls: turn.calls});

            for (const call of turn.calls) {
                const trace = await executeToolCall(deps.registry, call, emit, signal);
                traces.push(trace);

                working.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: trace.status === "done" ? trace.output ?? "(empty)" : `ERROR: ${trace.error ?? "tool failed"}`,
                });
            }
        }
    } catch (error) {
        emit({type: "error", message: errorMessage(error), retriable: true});
    }

    const record: ChatMessageRecord = {
        id: newId(),
        role: "assistant",
        content: assistantText,
        createdAt: new Date().toISOString(),
        model: params.model,
        ...(assistantThought ? {thought: assistantThought} : {}),
        ...(traces.length > 0 ? {traces} : {}),
    };

    deps.store.appendMessage(params.sessionId, record);
    emit({type: "message", message: record});

    if (usage) {
        emit({type: "usage", promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens});
    }
    emit({type: "done", sessionId: params.sessionId});
}
