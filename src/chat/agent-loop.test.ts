import {describe, expect, it} from "vitest";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type * as Gemini from "../types/gemini.js";
import type * as OpenAI from "../types/openai.js";
import type {UpstreamClient} from "../gemini/upstream-client.js";
import {McpToolRegistry} from "../mcp/tool-registry.js";
import type {Logger} from "../utils/logger.js";

import {runAgentTurn} from "./agent-loop.js";
import {ChatSessionStore} from "./store.js";
import type {ChatStreamEvent} from "./types.js";

const silentLogger: Logger = {info: () => undefined, debug: () => undefined, warn: () => undefined, error: () => undefined};

function chunk(delta: OpenAI.StreamDelta, finishReason: string | null = null): OpenAI.StreamChunk {
    return {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "test-model",
        choices: [{index: 0, delta, finish_reason: finishReason, logprobs: null}],
        usage: null,
    };
}

/** Streams a tool call on the first turn, then a plain answer. */
class ScriptedClient implements UpstreamClient {
    readonly requests: Gemini.ChatCompletionRequest[] = [];

    constructor(private readonly toolName: string) {}

    async discoverProjectId(): Promise<string> {
        return "test-project";
    }

    async getCompletion(): Promise<never> {
        throw new Error("unused in agent loop");
    }

    async* streamContent(request: Gemini.ChatCompletionRequest): AsyncGenerator<OpenAI.StreamChunk> {
        this.requests.push(request);

        if (this.requests.length === 1) {
            yield chunk({
                tool_calls: [
                    {
                        index: 0,
                        id: "call_calc",
                        type: "function",
                        function: {name: this.toolName, arguments: JSON.stringify({expression: "6*7"})},
                    },
                ],
            });
            yield chunk({}, "tool_calls");
            return;
        }

        yield chunk({content: "The answer is 42."});
        yield chunk({}, "stop", );
    }
}

describe("chat agent loop with MCP tools", () => {
    it("executes a built-in MCP tool and replays its result to the model", async () => {
        const registry = await McpToolRegistry.create({builtin: true, servers: []}, silentLogger);
        const calculator = registry.list().find((tool) => tool.name === "calculate");
        expect(calculator, "built-in calculate tool should be registered").toBeDefined();

        const client = new ScriptedClient(calculator!.id);
        const store = new ChatSessionStore(path.join(os.tmpdir(), `chat-test-${crypto.randomUUID()}`));
        const session = store.create("test-model");

        const events: ChatStreamEvent[] = [];
        await runAgentTurn(
            {client, registry, store, logger: silentLogger},
            {sessionId: session.id, model: "test-model", userText: "What is 6*7?"},
            (event) => events.push(event),
        );

        const toolStart = events.find((event) => event.type === "tool_start");
        const toolEnd = events.find((event) => event.type === "tool_end");
        expect(toolStart).toBeDefined();
        expect(toolEnd && toolEnd.trace.status).toBe("done");
        expect(toolEnd && toolEnd.trace.output).toContain("42");

        // The second upstream request must carry the tool result back to the model.
        expect(client.requests.length).toBe(2);
        expect(JSON.stringify(client.requests[1].request.contents)).toContain("42");

        // The replayed model turn must carry the function call itself; without it the
        // backend never sees an answered call and replans forever.
        const modelTurn = client.requests[1].request.contents.find((content) => content.role === "model");
        const replayed = JSON.stringify(modelTurn);
        expect(replayed).toContain("core__calculate");
        expect(replayed).toContain("call_calc");

        const stored = store.get(session.id);
        const assistant = stored?.messages.at(-1);
        expect(assistant?.role).toBe("assistant");
        expect(assistant?.content).toBe("The answer is 42.");
        expect(assistant?.traces?.[0]?.status).toBe("done");

        await registry.closeAll();
    });

    it("reports unknown tools as a trace error instead of throwing", async () => {
        const registry = await McpToolRegistry.create({builtin: true, servers: []}, silentLogger);
        const client = new ScriptedClient("core__does_not_exist");
        const store = new ChatSessionStore(path.join(os.tmpdir(), `chat-test-${crypto.randomUUID()}`));
        const session = store.create("test-model");

        const events: ChatStreamEvent[] = [];
        await runAgentTurn(
            {client, registry, store, logger: silentLogger},
            {sessionId: session.id, model: "test-model", userText: "use a missing tool"},
            (event) => events.push(event),
        );

        const toolEnd = events.find((event) => event.type === "tool_end");
        expect(toolEnd && toolEnd.trace.status).toBe("error");
        expect(toolEnd && toolEnd.trace.error).toContain("unknown tool");

        await registry.closeAll();
    });
});
