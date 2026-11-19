import crypto from "node:crypto";

import chalk from "chalk";

import type { AntigravityTokenStore } from "../auth/antigravity-token-store.js";
import * as Gemini from "../types/gemini.js";
import type * as OpenAI from "../types/openai.js";
import {
    API_VERSION,
    FALLBACK_PROJECT_ID,
    PROVISION_ENDPOINTS,
    antigravityHeaders,
    clientMetadata,
} from "../utils/antigravity-constants.js";
import { OPENAI_CHAT_COMPLETION_OBJECT } from "../utils/constant.js";
import { getLogger, Logger } from "../utils/logger.js";
import { GeminiApiError } from "./client.js";
import { buildAntigravityRequest } from "./antigravity-request-builder.js";
import {
    fallbackChain,
    fetchCatalogue,
    generationEndpoints,
    resolveModel,
    type AntigravityModel,
} from "./antigravity-models.js";
import type { CompletionResult, UpstreamClient, UpstreamModelInfo } from "./upstream-client.js";

type LoosePart = Record<string, unknown>;

interface BackendBody {
    candidates?: Gemini.Candidate[];
    usageMetadata?: Gemini.UsageMetadata;
}

interface BackendFrame extends Record<string, unknown> {
    response?: BackendBody;
    candidates?: Gemini.Candidate[];
    usageMetadata?: Gemini.UsageMetadata;
}

interface LoadCodeAssistResponse {
    cloudaicompanionProject?: string | { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

/**
 * Talks to the Antigravity entitlement on `cloudcode-pa` instead of the retired
 * Code Assist free tier. Emits the same OpenAI chunk stream as `GeminiApiClient`,
 * so both route layers run against either upstream unchanged.
 */
export class AntigravityClient implements UpstreamClient {
    private readonly logger: Logger;
    private readonly creationTime = Math.floor(Date.now() / 1000);
    private readonly chatId = `chat-${crypto.randomUUID()}`;

    constructor(
        private readonly tokens: AntigravityTokenStore,
        private readonly googleCloudProject?: string,
    ) {
        this.logger = getLogger("AGY-CLIENT", chalk.blue);
    }

    /** Resolves the quota project: flag -> env -> cache -> discovery -> onboarding. */
    async discoverProjectId(): Promise<string> {
        if (this.googleCloudProject) {
            return this.googleCloudProject;
        }

        const fromEnv = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
        if (fromEnv) {
            return fromEnv;
        }

        const cached = this.tokens.projectId;
        if (cached) {
            return cached;
        }

        const discovered = await this.loadCodeAssist();
        if (discovered) {
            this.tokens.setProject(discovered);
            return discovered;
        }

        const onboarded = await this.onboardUser();
        if (onboarded) {
            this.tokens.setProject(onboarded);
            return onboarded;
        }

        this.logger.warn(`project discovery failed; falling back to ${FALLBACK_PROJECT_ID}`);
        return FALLBACK_PROJECT_ID;
    }

    async listModels(): Promise<UpstreamModelInfo[]> {
        const token = await this.tokens.getAccessToken();
        const models = await fetchCatalogue(token, await this.discoverProjectId());
        return (models ?? []).map((model: AntigravityModel) => ({
            id: model.id,
            ownedBy: model.family === "claude" ? "anthropic" : "google",
            displayName: model.displayName ?? model.id,
        }));
    }

    async getCompletion(request: Gemini.ChatCompletionRequest, _isRetry = false): Promise<CompletionResult> {
        let content = "";
        const toolCalls: OpenAI.ToolCall[] = [];
        let usage: CompletionResult["usage"];

        for await (const chunk of this.streamContent(request)) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
                content += delta.content;
            }
            if (delta?.tool_calls) {
                toolCalls.push(...delta.tool_calls);
            }
            if (chunk.usage) {
                usage = {
                    inputTokens: chunk.usage.prompt_tokens,
                    outputTokens: chunk.usage.completion_tokens,
                };
            }
        }

        return {
            content,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            usage,
        };
    }

    async* streamContent(
        request: Gemini.ChatCompletionRequest,
        isRetry = false,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        const chain = fallbackChain(resolveModel(request.sourceModel ?? request.model));
        const project = await this.discoverProjectId();
        const sessionKey = this.sessionKey(request);

        let lastError: unknown = null;

        for (let index = 0; index < chain.length; index++) {
            const model = chain[index];
            const envelope = buildAntigravityRequest({ ...request, project }, model, sessionKey);

            // Hosts proven to list this id run first. Production answers 429 (not
            // 404) for ids it never served, which would masquerade as quota
            // exhaustion and force a pointless tier fallback.
            for (const endpoint of generationEndpoints(model)) {
                try {
                    yield* this.streamAgainst(endpoint, envelope, model.id);
                    return;
                } catch (error) {
                    lastError = error;

                    if (error instanceof GeminiApiError && error.statusCode === 401 && !isRetry) {
                        this.logger.warn("access token rejected; refreshing and retrying");
                        this.tokens.invalidateAccessToken();
                        yield* this.streamContent(request, true);
                        return;
                    }
                    if (error instanceof GeminiApiError && error.statusCode === 400) {
                        throw error;
                    }
                    if (error instanceof GeminiApiError && error.statusCode === 429) {
                        // Quota is shared across both endpoints, so only another tier helps.
                        this.logger.warn(`${model.id} quota exhausted on ${endpoint}; trying another tier`);
                        break;
                    }
                    const detail = error instanceof Error ? error.message : String(error);
                    this.logger.warn(`${endpoint} failed for ${model.id}: ${detail}`);
                }
            }
        }

        throw lastError ?? new GeminiApiError("Antigravity request failed on every endpoint and tier", 502);
    }

    private async* streamAgainst(
        endpoint: string,
        envelope: ReturnType<typeof buildAntigravityRequest>,
        modelId: string,
    ): AsyncGenerator<OpenAI.StreamChunk> {
        const token = await this.tokens.getAccessToken();
        const response = await fetch(`${endpoint}/${API_VERSION}:streamGenerateContent?alt=sse`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                ...antigravityHeaders("text/event-stream"),
                "X-Machine-Session-Id": envelope.request.sessionId,
            },
            body: JSON.stringify(envelope),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new GeminiApiError(
                `Antigravity ${modelId} rejected (${response.status}): ${detail.slice(0, 400)}`,
                response.status,
                detail,
            );
        }

        let firstChunk = true;
        let thinkingInProgress = false;
        let sawToolCall = false;
        let usage: OpenAI.UsageData | undefined;

        for await (const frame of readSseFrames(response.body)) {
            const body: BackendBody = frame.response ?? frame;
            const candidate = body.candidates?.[0];

            if (body.usageMetadata) {
                const prompt = body.usageMetadata.promptTokenCount ?? 0;
                // Thinking tokens are billed as output by this backend.
                const completion =
          (body.usageMetadata.candidatesTokenCount ?? 0) + (body.usageMetadata.thoughtsTokenCount ?? 0);
                usage = {
                    prompt_tokens: prompt,
                    completion_tokens: completion,
                    total_tokens: prompt + completion,
                };
            }

            for (const part of candidate?.content?.parts ?? []) {
                const loose = part as LoosePart;

                if ("text" in part && typeof part.text === "string") {
                    const signature =
            (loose.thoughtSignature as string) ?? (loose.thought_signature as string) ?? "";

                    if (loose.thought === true) {
                        const delta: OpenAI.StreamDelta & Record<string, unknown> = {
                            content: part.text,
                            _thought: true,
                            _thoughtSignature: signature,
                        };
                        if (firstChunk) {
                            delta.role = "assistant";
                            firstChunk = false;
                        }
                        if (!thinkingInProgress) {
                            delta._thinkingStart = true;
                            thinkingInProgress = true;
                        }
                        yield this.chunk(delta, modelId);
                    } else {
                        if (thinkingInProgress) {
                            yield this.chunk(thinkingEndDelta(), modelId);
                            thinkingInProgress = false;
                        }
                        const delta: OpenAI.StreamDelta = { content: part.text };
                        if (firstChunk) {
                            delta.role = "assistant";
                            firstChunk = false;
                        }
                        yield this.chunk(delta, modelId);
                    }
                } else if ("functionCall" in part && part.functionCall) {
                    if (thinkingInProgress) {
                        yield this.chunk(thinkingEndDelta(), modelId);
                        thinkingInProgress = false;
                    }
                    sawToolCall = true;

                    const toolCall = {
                        index: 0,
                        id: `call_${crypto.randomUUID()}`,
                        type: "function" as const,
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args ?? {}),
                        },
                        _thoughtSignature:
              (loose.thoughtSignature as string) ?? (loose.thought_signature as string) ?? "",
                    };

                    const delta: OpenAI.StreamDelta & Record<string, unknown> = {
                        tool_calls: [toolCall as unknown as OpenAI.ToolCall],
                    };
                    if (firstChunk) {
                        delta.role = "assistant";
                        delta.content = null;
                        firstChunk = false;
                    }
                    yield this.chunk(delta, modelId);
                }
            }

            if (candidate?.finishReason) {
                yield this.finalChunk(modelId, sawToolCall, usage);
                return;
            }
        }

        if (thinkingInProgress) {
            yield this.chunk(thinkingEndDelta(), modelId);
        }
        yield this.finalChunk(modelId, sawToolCall, usage);
    }

    private chunk(delta: OpenAI.StreamDelta, modelId: string, finishReason: string | null = null): OpenAI.StreamChunk {
        return {
            id: this.chatId,
            object: OPENAI_CHAT_COMPLETION_OBJECT,
            created: this.creationTime,
            model: modelId,
            choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
            usage: null,
        };
    }

    private finalChunk(
        modelId: string,
        sawToolCall: boolean,
        usage?: OpenAI.UsageData,
    ): OpenAI.StreamChunk {
        const chunk = this.chunk({}, modelId, sawToolCall ? "tool_calls" : "stop");
        if (usage) {
            chunk.usage = usage;
        }
        return chunk;
    }

    /** Stable per-conversation id so backend prompt cache can be reused. */
    private sessionKey(request: Gemini.ChatCompletionRequest): string {
        const seed = JSON.stringify(request.request.contents?.[0] ?? "");
        return `chat-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
    }

    private async loadCodeAssist(): Promise<string | null> {
        const token = await this.tokens.getAccessToken();
        for (const endpoint of PROVISION_ENDPOINTS) {
            try {
                const response = await fetch(`${endpoint}/${API_VERSION}:loadCodeAssist`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, ...antigravityHeaders() },
                    body: JSON.stringify({ metadata: clientMetadata(), mode: 1 }),
                });
                if (!response.ok) {
                    this.logger.debug(`loadCodeAssist at ${endpoint} -> ${response.status}`);
                    continue;
                }
                const data = (await response.json()) as LoadCodeAssistResponse;
                const project =
          typeof data.cloudaicompanionProject === "string"
              ? data.cloudaicompanionProject
              : data.cloudaicompanionProject?.id;
                if (project) {
                    return project;
                }
            } catch (error) {
                this.logger.debug(`loadCodeAssist error at ${endpoint}: ${(error as Error).message}`);
            }
        }
        return null;
    }

    private async onboardUser(): Promise<string | null> {
        const token = await this.tokens.getAccessToken();
        for (const endpoint of PROVISION_ENDPOINTS) {
            try {
                const load = await fetch(`${endpoint}/${API_VERSION}:loadCodeAssist`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}`, ...antigravityHeaders() },
                    body: JSON.stringify({ metadata: clientMetadata(), mode: 1 }),
                });
                if (!load.ok) {
                    continue;
                }

                const data = (await load.json()) as LoadCodeAssistResponse;
                const tierId =
          data.allowedTiers?.find((tier) => tier.isDefault)?.id ??
          data.allowedTiers?.[0]?.id ??
          "free-tier";

                for (let attempt = 0; attempt < 10; attempt++) {
                    const onboard = await fetch(`${endpoint}/${API_VERSION}:onboardUser`, {
                        method: "POST",
                        headers: { Authorization: `Bearer ${token}`, ...antigravityHeaders() },
                        body: JSON.stringify({ tierId, metadata: clientMetadata() }),
                    });
                    if (!onboard.ok) {
                        break;
                    }
                    const result = (await onboard.json()) as Gemini.OnboardUserResponse;
                    const project = result.response?.cloudaicompanionProject?.id;
                    if (result.done && project) {
                        return project;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                }
            } catch (error) {
                this.logger.debug(`onboardUser error at ${endpoint}: ${(error as Error).message}`);
            }
        }
        return null;
    }
}

function thinkingEndDelta(): OpenAI.StreamDelta & Record<string, unknown> {
    return { content: "", _thinkingEnd: true };
}

/** Yields parsed JSON frames from an SSE byte stream. */
async function* readSseFrames(body: ReadableStream<Uint8Array> | null): AsyncGenerator<BackendFrame> {
    if (!body) {
        return;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                if (!line.startsWith("data:")) {
                    continue;
                }
                const text = line.slice(5).trim();
                if (!text || text === "[DONE]") {
                    continue;
                }
                try {
                    yield JSON.parse(text) as BackendFrame;
                } catch {
          // Incomplete frame; the next read completes it.
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
