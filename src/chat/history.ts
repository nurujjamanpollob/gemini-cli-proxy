/**
 * Converts persisted UI transcripts back into the OpenAI message shape the
 * mappers expect, re-expanding tool traces into assistant `tool_calls` plus
 * matching `role: "tool"` results so multi-turn tool conversations replay
 * correctly against Gemini.
 */

import type * as OpenAI from "../types/openai.js";
import type {ChatMessageRecord} from "./types.js";

/** Records kept in the model context window for one run. */
export const MAX_HISTORY_RECORDS = 40;

function stringifyArguments(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return "{}";
    }
}

/** Drops the oldest records, always keeping a leading user turn. */
export function trimHistory(records: ChatMessageRecord[], limit = MAX_HISTORY_RECORDS): ChatMessageRecord[] {
    if (records.length <= limit) {
        return records;
    }

    let trimmed = records.slice(records.length - limit);
    while (trimmed.length > 1 && trimmed[0].role !== "user") {
        trimmed = trimmed.slice(1);
    }
    return trimmed;
}

/** Expands a transcript into OpenAI chat messages (system prompt excluded). */
export function toOpenAiMessages(records: ChatMessageRecord[]): OpenAI.ChatMessage[] {
    const messages: OpenAI.ChatMessage[] = [];

    for (const record of records) {
        if (record.role === "user") {
            messages.push({role: "user", content: record.content});
            continue;
        }

        const traces = (record.traces ?? []).filter((trace) => trace.status !== "running");
        if (traces.length === 0) {
            messages.push({role: "assistant", content: record.content || ""});
            continue;
        }

        messages.push({
            role: "assistant",
            content: record.content || "",
            tool_calls: traces.map((trace, index) => ({
                index,
                id: trace.id,
                type: "function" as const,
                ...(trace.signature ? {_thoughtSignature: trace.signature} : {}),
                function: {name: trace.toolId, arguments: stringifyArguments(trace.arguments)},
            })),
        });

        for (const trace of traces) {
            messages.push({role: "tool", tool_call_id: trace.id, content: trace.output ?? "(no output)"});
        }
    }

    return messages;
}
