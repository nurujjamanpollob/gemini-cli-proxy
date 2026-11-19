# GEMINI.md

## Development Commands

### Build & Development
- `npm run dev` - Start development server with hot reload using ts-node
- `npm run build` - Build TypeScript to JavaScript in `dist/` directory
- `npm start` - Start production server from built files

### Testing
- `npm test` - Run all tests
- `npm test:cov` - Run all tests with coverage report
- `vitest <test-file>` - Run specific test file
- Coverage reports are generated in `coverage/` directory

### Code Quality
- `npm run lint` - Run ESLint on TypeScript files
- `npm run lint -- --fix` - Auto-fix linting issues
- Follow `.editorconfig` for code formatting (4-space indentation, double quotes)

## Architecture Overview

This is a proxy server that provides OpenAI and Anthropic Claude-compatible APIs backed by Google's Gemini models through the Code Assist endpoint.

### Core Components

**Main Server (`src/index.ts`)**
- Express server with custom JSON parsing middleware
- Command-line interface using Commander.js
- Google OAuth authentication setup
- Health check endpoint at `/health`

**API Routes**
- `/openai/*` - OpenAI-compatible endpoints (chat completions, models)
- `/anthropic/*` - Anthropic Claude-compatible endpoints (messages, models)

**Gemini Client (`src/gemini/client.ts`)**
- `GeminiApiClient` class handles Google Code Assist API communication
- Project discovery and authentication management
- Both streaming and non-streaming completion support

**Type System (`src/types/`)**
- Comprehensive TypeScript definitions for OpenAI, Anthropic, and Gemini APIs
- Separate type files for each API format

**Mappers (`src/gemini/`)**
- `openai-mapper.ts` - Converts OpenAI requests to Gemini format
- `anthropic-mapper.ts` - Converts Anthropic requests to Gemini format and responses back
- Handles model mapping (Claude models → Gemini models)
- Tool schema conversion with `$schema` removal for Anthropic compatibility

### Authentication Flow
Uses Google OAuth2 for authentication with Code Assist API. Can run in browser mode (default) or disable browser auth for code-based flow.

## Verified Runtime Contract (live-server checks)

- `GET /health` -> `200 {"status":"ok"}`
- OpenAI surface: `GET /openai/models`, `POST /openai/chat/completions`. There is **no `/v1` prefix**; `/openai/v1/...` returns 404. OpenAI SDK `base_url` must be `http://localhost:3456/openai`.
- Anthropic surface: `GET /anthropic/v1/models`, `POST /anthropic/v1/messages`; base URL is `http://localhost:3456/anthropic`.
- Model ids come from `src/types/gemini.ts`: `gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-flash-lite-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. Aliases and `[Nm]` suffix stripping live in `src/gemini/mapper.ts` (`mapModelToGemini`). The README model table (1.5 series) is stale.
- Project id resolution order: `-g/--google-cloud-project` -> `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` env -> `loadCodeAssist` discovery (+ `onboardUser` polling).

## Known Upstream Blocker — Code Assist upstream only (`--upstream code-assist`) (verified 2026-11-19)

Google disabled the Code Assist free tier for this OAuth client. With cached `~/.gemini/oauth_creds.json`:

- `v1internal:loadCodeAssist` -> `allowedTiers=[standard-tier]`, `ineligibleTiers=[free-tier:UNSUPPORTED_CLIENT]` ("This client is no longer supported for Gemini Code Assist for individuals ... migrate to the Antigravity suite").
- `v1internal:streamGenerateContent` -> `403 PERMISSION_DENIED` / reason `SUBSCRIPTION_REQUIRED`, error number 3501, on both `daily-cloudcode-pa.googleapis.com` and `cloudcode-pa.googleapis.com`. Identical result for every `pluginType`/User-Agent variant except an invalid `ANTIGRAVITY` enum (400).
- Effect: proxy is healthy and speaks OpenAI/Anthropic correctly, but upstream generation fails with HTTP 403 unless the account holds a licensed Code Assist Standard/Enterprise project (`GOOGLE_CLOUD_PROJECT`) or the client is re-pointed at another upstream (Gemini Developer API key / Vertex AI).

## Antigravity Upstream (default since 2026-11-19)

Selected with `--upstream antigravity` (also the default; `UPSTREAM_PROVIDER=code-assist` or `--upstream code-assist` restores the legacy path). Files: `src/utils/antigravity-constants.ts`, `src/auth/antigravity-auth.ts`, `src/auth/antigravity-token-store.ts`, `src/gemini/antigravity-client.ts`, `src/gemini/antigravity-request-builder.ts`, `src/gemini/antigravity-models.ts`, `src/gemini/upstream-client.ts` (shared interface implemented by both clients).

### Wire contract (live-verified)
- RPC paths use the **colon** transcoding form: `${endpoint}/v1internal:${rpc}` — e.g. `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`. The slash form (`/v1internal/loadCodeAssist`) returns an HTML 404 from the Google front end.
- Endpoints: generation prefers `daily-cloudcode-pa.googleapis.com` then `cloudcode-pa.googleapis.com`; provisioning (`loadCodeAssist`, `onboardUser`, `fetchAvailableModels`) prefers production first.
- Required headers (`antigravityHeaders()`): `User-Agent: antigravity/hub/<ideVersion> <os>/<arch>`, `X-Client-Name: antigravity`, `X-Client-Version`, `x-goog-api-client`.
- `loadCodeAssist` body `{ metadata: clientMetadata(), mode: 1 }` -> **200** with `currentTier.id="free-tier"`, `name="Antigravity"`, and quota project in `cloudaicompanionProject` (this account resolves to `aicode-consumers`). No `UNSUPPORTED_CLIENT` message on this path.
- Generation envelope: `{ project, model, request: { contents, generationConfig, sessionId, tools?, toolConfig? }, userAgent: "antigravity", requestType: "agent", requestId }`. Field names are strict protobuf: top-level `projectId` and inner `config` are rejected with 400; `project` / `generationConfig` are accepted. `fetchAvailableModels` accepts `{ project }` only (`userAgent` there -> 400).
- Model catalogue is fetched live from `v1internal:fetchAvailableModels` (5 min cache) and falls back to the seed list in `antigravity-models.ts`. Aliases fold legacy names (`gemini-2.5-*`, `*-preview`) onto `gemini-3.1-pro-high`, `gemini-3.1-pro-low`, `gemini-3-flash-thinking`, `gemini-3-flash-low`; Claude tiers (`claude-opus-4-6-thinking`, `claude-sonnet-4-6[-thinking]`) are reachable through the Anthropic surface.

### Entitlement requirement (verified 2026-11-19)
A Gemini CLI / Code Assist token cannot generate on this backend: with a valid `~/.gemini/oauth_creds.json` refresh, `loadCodeAssist` answers 200 but `streamGenerateContent` and `fetchAvailableModels` return `403 PERMISSION_DENIED ("The caller does not have permission")` for every project (`ecommerce-temp-api`, `aicode-consumers`, empty, shared fallback) and model. The gate is the token scope set: Antigravity requires a token minted by client id `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` with the `cclog` + `experimentsandconfigs` scopes, which only the interactive PKCE sign-in grants. Refresh tokens are client-bound, so no cross-client reuse is possible.

### Sign-in and cache
- Interactive PKCE loopback flow on ports 51121-51126 (`OAUTH_CALLBACK_PORT` overrides); `--disable-browser-auth`, `NO_BROWSER` or `CI` switches to paste-the-redirect-URL mode. Timeout: 600 s, override with `ANTIGRAVITY_AUTH_TIMEOUT_SECONDS`.
- Credentials are cached in `~/.gemini/antigravity_oauth_creds.json` (mode 0600), deliberately separate from the Code Assist `oauth_creds.json`, and hold `access_token`, `refresh_token`, `expiry_date`, `email`, `project_id`. Delete that file to force re-auth.
- Terminal-less runs cannot complete first-time auth: the browser callback must land on the same host running the proxy.

### Live catalogue (verified 2026-11-19, `v1internal:fetchAvailableModels`)
`gemini-3.8-flash-high`, `gemini-3.8-flash-tiered`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-flash-image`, `gemini-3-flash`, `gemini-2.5-pro`, `gemini-2.5-flash-thinking`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `claude-opus-4-6-thinking`, `claude-sonnet-4-6`, `gpt-oss-120b-medium`.

Caller names are mapped to capability buckets (`TierRole = opus | sonnet | pro | flash | lite`) through `ROLE_ALIASES` + `roleOf()`, then resolved to the first live id in `TIER_PREFERENCE`; backend ids must never be hardcoded in routes because Google rewrites the catalogue. `fallbackChain(model, 3)` produces the quota fallback order.

### Verified end-to-end (2026-11-19, proxy on :8085 with cached Antigravity creds)
- OpenAI non-streaming: `gemini-2.5-flash`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, unknown alias `gpt-4o`, `claude-opus-4-6-thinking` -> all 200 with sane content and usage.
- OpenAI streaming: SSE chunks + final usage frame; tool calling returns `tool_calls` with function name, JSON arguments and `_thoughtSignature`.
- Anthropic surface: `/anthropic/v1/messages` non-streaming (`claude-sonnet-4-6`) and streaming (`content_block_start/delta/stop`), plus `stop_reason=tool_use` with a correct `input` object.
- `/openai/models` and `/anthropic/v1/models` both serve the live catalogue.
- Claude tiers require `maxOutputTokens > thinking.budget_tokens`; `normalizeGenerationConfig()` in `antigravity-request-builder.ts` reconciles them (default budget 16000, headroom 4096, ceiling 65536) and drops thinking when the caller cap is <= 2048.
- Quota handling: HTTP 429 on one tier triggers `fallbackChain()` retry on the next tier (max 3); 400 is fatal; 401 refreshes the token once.

### Known limitations
- Thinking output from Claude/Gemini thinking tiers is concatenated into normal assistant text on the OpenAI surface (`reasoning_content` stays empty). `antigravity-client.ts` only tags a part as thought when the backend sets `part.thought === true`; when it does not, `routes/anthropic.ts` never sees tagged parts and emits plain text.
- Sending a raw model id that is absent from the live catalogue straight to the backend returns 404; proxy-side resolution prevents this for caller-supplied names.
- Test baseline (unchanged by this work): 5 pre-existing failures — `mapper.test.ts` (`additionalProperties` / schema cases x4) and `anthropic-mapper.test.ts` (empty-text newline case x1).
