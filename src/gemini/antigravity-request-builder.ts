import crypto from "node:crypto";

import * as Gemini from "../types/gemini.js";
import {MAX_OUTPUT_TOKENS} from "../utils/antigravity-constants.js";
import type {ResolvedModel} from "./antigravity-models.js";

/** Envelope expected by `v1internal:{generateContent,streamGenerateContent}`. */
export interface AntigravityEnvelope {
    project: string;
    model: string;
    request: Record<string, unknown> & {sessionId: string};
    userAgent: "antigravity";
    requestType: "agent";
    requestId: string;
}

const KEEP_SYSTEM_INSTRUCTION = process.env.ANTIGRAVITY_KEEP_SYSTEM_INSTRUCTION === "1";

function systemText(body: Gemini.ChatCompletionRequestBody): string {
    const parts = body.systemInstruction?.parts ?? [];
    return parts
        .map((part) => part.text ?? "")
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

/**
 * cloudcode-pa classifies `systemInstruction` and answers an opaque 429 for
 * some agent prompts placed there, while identical text inside `contents` is
 * accepted. Caller system prompts therefore travel as a user-turn block.
 */
function relocateSystemPrompt(request: Record<string, unknown>, body: Gemini.ChatCompletionRequestBody): void {
    const text = systemText(body);
    if (!text) {
        return;
    }

    delete request.systemInstruction;

    const contents = (request.contents as Gemini.ChatMessage[]) ?? [];
    const part: Gemini.TextPart = {text: `<system-instructions>\n${text}\n</system-instructions>`};
    const first = contents[0];
    const firstIsToolResult = Boolean(first?.parts?.[0] && "functionResponse" in first.parts[0]);

    if (first && first.role === "user" && Array.isArray(first.parts) && !firstIsToolResult) {
        first.parts = [part, ...first.parts];
    } else {
        request.contents = [{role: "user", parts: [part]}, ...contents];
    }
}

/** Guarantees every content message carries at least one usable part. */
function normalizeContents(contents: unknown): Gemini.ChatMessage[] {
    const list = Array.isArray(contents) ? (contents as Gemini.ChatMessage[]) : [];
    return list.map((message) => {
        const parts = (message.parts ?? []).filter((part) => {
            if ("text" in part && typeof part.text === "string") {
                return part.text.length > 0;
            }
            return true;
        });

        if (parts.length === 0) {
            parts.push({text: "."});
        }
        return {role: message.role, parts};
    });
}

/** Vertex rejects `max_tokens <= thinking.budget_tokens`; keep them apart. */
const CLAUDE_MIN_THINKING_TOKENS = 1024;
/** Output tokens reserved above a thinking budget so requests stay valid. */
const THINKING_HEADROOM = 4096;
/** Default Claude extended-thinking budget when the caller asks for none. */
const DEFAULT_CLAUDE_BUDGET = 16000;

function clampCeiling(value: number | undefined, ceiling: number): number {
    return Math.min(value ?? ceiling, ceiling);
}

/**
 * Rewrites the mapper's Code Assist thinking config into the shape the
 * Antigravity backend accepts for the resolved model family. Claude tiers are
 * proxied to Vertex, which rejects a `maxOutputTokens` that does not exceed
 * `thinking.budget_tokens`, so both values are reconciled here.
 */
function normalizeGenerationConfig(
    body: Gemini.ChatCompletionRequestBody,
    model: ResolvedModel,
): Record<string, unknown> {
    const source = (body.generationConfig ?? {}) as Record<string, unknown>;
    const config: Record<string, unknown> = {};

    for (const key of ["temperature", "topP", "topK", "stopSequences"] as const) {
        if (source[key] !== undefined) {
            config[key] = source[key];
        }
    }

    const requestedMax = typeof source.maxOutputTokens === "number" ? source.maxOutputTokens : undefined;
    const rawThinking = source.thinkingConfig as Record<string, unknown> | undefined;
    const requestedBudget = typeof rawThinking?.thinkingBudget === "number" ? rawThinking.thinkingBudget : undefined;
    const thinkingWanted = model.supportsThinking && rawThinking?.includeThoughts !== false;

    if (!thinkingWanted) {
        config.maxOutputTokens = clampCeiling(requestedMax, MAX_OUTPUT_TOKENS);
        return config;
    }

    if (model.family === "claude") {
        // A caller cap with no room for thinking wins over thinking itself.
        if (requestedMax !== undefined && requestedMax <= CLAUDE_MIN_THINKING_TOKENS * 2) {
            config.maxOutputTokens = clampCeiling(requestedMax, MAX_OUTPUT_TOKENS);
            return config;
        }

        let budget = Math.min(requestedBudget ?? DEFAULT_CLAUDE_BUDGET, MAX_OUTPUT_TOKENS - THINKING_HEADROOM);
        if (requestedMax !== undefined) {
            budget = Math.min(budget, requestedMax - CLAUDE_MIN_THINKING_TOKENS);
        }
        budget = Math.max(CLAUDE_MIN_THINKING_TOKENS, budget);

        config.thinkingConfig = {include_thoughts: true, thinking_budget: budget};
        const floor = Math.min(budget + THINKING_HEADROOM, MAX_OUTPUT_TOKENS);
        config.maxOutputTokens = Math.min(Math.max(requestedMax ?? floor, floor), MAX_OUTPUT_TOKENS);
        return config;
    }

    // Gemini: a zero budget means the backend decides how much to think.
    let budget = requestedBudget ?? 0;
    if (budget > 0) {
        budget = Math.min(budget, MAX_OUTPUT_TOKENS - THINKING_HEADROOM);
        if (requestedMax !== undefined) {
            budget = Math.min(budget, Math.max(1, requestedMax - 1));
        }
    }

    config.thinkingConfig = {
        includeThoughts: true,
        ...(budget > 0 ? {thinkingBudget: budget} : {}),
    };

    const floor = budget > 0 ? Math.min(budget + THINKING_HEADROOM, MAX_OUTPUT_TOKENS) : clampCeiling(requestedMax, MAX_OUTPUT_TOKENS);
    config.maxOutputTokens = Math.min(Math.max(requestedMax ?? floor, floor), MAX_OUTPUT_TOKENS);
    return config;
}

/** Claude tiers on this backend validate tool arguments server-side. */
function normalizeToolConfig(
    body: Gemini.ChatCompletionRequestBody,
    model: ResolvedModel,
): Gemini.ToolConfig | undefined {
    if (body.toolConfig) {
        return body.toolConfig;
    }
    if (model.family === "claude" && body.tools && body.tools.length > 0) {
        return {functionCallingConfig: {mode: "AUTO" as never}};
    }
    return undefined;
}

/**
 * Builds the Antigravity request envelope from a mapper-produced request.
 * `sessionId` is stable per conversation so backend prompt caching applies.
 */
export function buildAntigravityRequest(
    completionRequest: Gemini.ChatCompletionRequest,
    model: ResolvedModel,
    sessionId: string,
): AntigravityEnvelope {
    const body = completionRequest.request;

    const request: Record<string, unknown> = {
        contents: normalizeContents(body.contents),
        generationConfig: normalizeGenerationConfig(body, model),
        sessionId,
    };

    if (body.tools && body.tools.length > 0) {
        request.tools = body.tools;
    }

    const toolConfig = normalizeToolConfig(body, model);
    if (toolConfig) {
        request.toolConfig = toolConfig;
    }

    if (KEEP_SYSTEM_INSTRUCTION && body.systemInstruction) {
        request.systemInstruction = body.systemInstruction;
    } else {
        relocateSystemPrompt(request, body);
    }

    return {
        project: completionRequest.project,
        model: model.id,
        request: request as AntigravityEnvelope["request"],
        userAgent: "antigravity",
        requestType: "agent",
        requestId: `agent-${crypto.randomUUID()}`,
    };
}
