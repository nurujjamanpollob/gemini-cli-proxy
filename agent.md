# agent.md — project ground truth

Read this before touching code. Update it when architecture, commands or invariants change.

## What this is

Node/TypeScript proxy that exposes **OpenAI-compatible**, **Anthropic-compatible** and a first-party
**chat console + MCP tool-calling** surface on top of Google upstreams (`antigravity` default,
legacy `code-assist`). No build step for the UI; TypeScript compiles with `tsc` only.

## Commands

| Task | Command |
|------|---------|
| dev server (ts, ESM loader) | `npm run dev` |
| compile | `npm run build` → `dist/` (`npm start` runs `dist/index.js`) |
| typecheck | `npx tsc --noEmit` |
| tests | `npm test` (vitest; also writes `junit.xml`, coverage via v8) |
| lint my code | `npx eslint src/mcp src/chat src/routes/chat.ts src/utils/runtime-paths.ts public` |
| full lint | `npm run lint` (**~90 pre-existing errors** in legacy files: `src/routes/anthropic.ts`, etc.) |

Baseline test failures (also fail on clean `main`, tracked in README "Known issues"): 5 —
4 × `mapJsonSchemaToGemini` in `src/gemini/mapper.test.ts`, 1 × empty-text in
`src/gemini/anthropic-mapper.test.ts`. Never count these as regressions.

## Runtime layout

- `src/index.ts` — composition root: auth → upstream client → MCP registry → routers (`/openai`,
  `/anthropic`, `/chat`, static `/ui`) → listen. Static dir resolved by
  `src/utils/runtime-paths.ts:getStaticUiDir()` (works for `src/` dev and `dist/` prod).
- `src/gemini/` — upstream clients + mappers. `openai-mapper.ts` maps OpenAI ⇄ Gemini;
  `antigravity-client.ts` streams `v1internal` SSE and tags deltas with `_thought`,
  `_thinkingStart/_thinkingEnd`, `_thoughtSignature`; `antigravity-request-builder.ts` builds the
  envelope (relocates system prompt into a user turn, reconciles thinking budget vs maxOutputTokens).
- `src/chat/` — first-party agent loop + session persistence.
- `src/mcp/` — MCP client layer (config, builtin tools, registry) and the arithmetic parser.
- `public/chat/` — vanilla ES-module console (`index.html`, `css/`, `js/{api,markdown,render,app}.js`).

## Hard invariants

1. **Tool-loop replay**: every round that produced tool calls MUST push an assistant message
   carrying `tool_calls` *before* the `role:"tool"` results (`src/chat/agent-loop.ts`). Omitting it
   makes the Antigravity backend re-issue the identical call forever (observed: 6 rounds, no answer).
2. **Call correlation ids**: replayed `functionCall.id` / `functionResponse.id` must equal the
   upstream call id (`src/types/gemini.ts`, `openai-mapper.ts`). Without ids the backend cannot link
   a response to its call and replans.
3. **Thought signatures** are surfaced as `_thoughtSignature` on tool calls and echoed back via
   `thoughtSignature` + `thought_signature`. Synthetic value `skip_thought_signature_validator` is
   the fallback; never invent other placeholders.
4. **SSE client disconnect**: abort the run from `res.on("close")` guarded by `!res.writableEnded`.
   `req.on("close")` fires as soon as the body is consumed (custom JSON parser) and kills turns
   before they start.
5. **Event contract** (`src/chat/types.ts:ChatStreamEvent`): `session`, `round`, `token`, `thought`,
   `tool_start`, `tool_end`, `message`, `usage`, `error`, `done`. The browser switch in
   `public/chat/js/app.js:handleEvent` is keyed to these exact strings - rename both sides together.
   `tool_end` is emitted exactly once per call, by `executeToolCall` only.
6. **MCP tool ids** exposed to models are `server__tool`; filters (`include`/`exclude`) use raw names.
7. **Config discovery order**: `--mcp-config` → `PROXY_MCP_CONFIG` → `./mcp.config.json` →
   `~/.gemini/mcp.config.json`. Missing config = warning, never fatal. Sessions persist one file per
   session under `data/chats/<id>.json` (gitignored); UI prefs live in localStorage only.
8. **No auth on `/chat/api/*`** (mirrors existing proxy behaviour): bind to localhost or front it.
9. **Builtin tools**: the `core` MCP server is in-process (`createBuiltinMcpServer`) and must stay
   dependency-light; the calculator parser (`src/mcp/expression.ts`) is a hand-written shunting-yard
   evaluator - no `eval`, bounded length/depth, explicit errors.
10. **Rewind contract**: `/chat/api/sessions/:id/rewind` drops records from `fromIndex` onwards, and
    the UI's `MessageView.recordIndex` (assigned in `public/chat/js/thread.js`) is a turn's position in
    `ChatSession.messages`. Edit / regenerate = rewind to the user record, then re-send that text.

## Style constraints (enforced by eslint for new code)

4-space indent, double quotes, `Array<T>` over `T[]` for non-simple types, no `{ ... }` inner spacing
in inline object *types*, browser globals declared in `eslint.config.js` for `public/**`.

## Verification habits that caught real bugs here

- Live SSE probe against `/chat/api/stream` (round/traces/usage) — unit tests with a fake client can
  miss request-shape bugs; assert the *second* upstream request contains the model turn.
- `GET /openai/models`, `GET /chat/api/tools`, `GET /ui` after every server change.
- CDP page probe for UI wiring (model/session/tool counts) instead of eyeballing.
