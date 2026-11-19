import * as Gemini from "../types/gemini.js";
import type * as OpenAI from "../types/openai.js";

/** Model descriptor shared by both upstream providers. */
export interface UpstreamModelInfo {
    id: string;
    ownedBy: string;
    displayName?: string;
}

export interface CompletionUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface CompletionResult {
    content: string;
    tool_calls?: OpenAI.ToolCall[];
    usage?: CompletionUsage;
    _autoSwitchNotification?: string;
}

/**
 * The contract every upstream (Code Assist, Antigravity) must satisfy.
 * Routes depend on this abstraction only, so providers stay swappable.
 */
export interface UpstreamClient {
    discoverProjectId(): Promise<string>;
    getCompletion(
        request: Gemini.ChatCompletionRequest,
        isRetry?: boolean,
    ): Promise<CompletionResult>;
    streamContent(
        request: Gemini.ChatCompletionRequest,
        isRetry?: boolean,
    ): AsyncGenerator<OpenAI.StreamChunk>;
    /** Optional dynamic catalogue; absent means "serve the static model list". */
    listModels?(): Promise<UpstreamModelInfo[]>;
}

/** Static catalogue used when an upstream does not expose a live model list. */
export function staticModelInfo(): UpstreamModelInfo[] {
    return (Object.values(Gemini.Model) as string[]).map((id) => ({
        id,
        ownedBy: "Google",
        displayName: id,
    }));
}

/** Resolves the model catalogue for any upstream, degrading to the static list. */
export async function resolveModelInfo(client: UpstreamClient): Promise<UpstreamModelInfo[]> {
    if (!client.listModels) {
        return staticModelInfo();
    }
    try {
        const models = await client.listModels();
        return models.length > 0 ? models : staticModelInfo();
    } catch {
        return staticModelInfo();
    }
}
