# 🚀 Gemini CLI Proxy

<div align="center">

[![Node.js](https://img.shields.io/badge/Node.js-%3E20-43853D?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=for-the-badge)](LICENSE)

**OpenAI- and Anthropic-compatible gateway in front of your Google account's model entitlements.**

Gemini, Claude and gpt-oss models through one local server — no API keys, no billing, just the OAuth login you already have.

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔌 **Dual API surface** | OpenAI-compatible *and* Anthropic-compatible endpoints from a single process |
| 🎛️ **Two upstreams** | `antigravity` (default, live entitlement) and legacy `code-assist`, switchable at launch |
| 📡 **Live model catalogue** | `fetchAvailableModels` is unioned across *both* provisioning hosts, so daily-only ids are still selectable |
| 🧩 **Capability resolution** | Caller names map to capability buckets (`opus`/`sonnet`/`pro`/`flash`/`lite`), never to hardcoded ids that Google retires between releases |
| 🔁 **Quota fallback chain** | A `429` walks up to three tiers of the same family instead of failing the request |
| 🎯 **Endpoint affinity** | Hosts proven to serve an id are tried first; production answers `429` for ids it never listed, which would otherwise look like quota exhaustion |
| 🔧 **Tool calling** | Full function/tool-calling support on both surfaces, including Anthropic `tool_use` stop reasons |
| 🌊 **Streaming** | SSE on `/openai/chat/completions` and `/anthropic/v1/messages`, with usage in the final frame |
| 🤔 **Thinking tiers** | `-thinking` / high-reasoning models pass through; `[Nm]` budget suffix supported on the OpenAI surface |
| 🔐 **OAuth PKCE, cached** | Browser consent once; tokens persisted `0600` and refreshed automatically per upstream |
| 💬 **Chat console** | Dependency-free web UI at `/ui`: streaming answers, reasoning, tool cards, persistent sessions |
| 🧰 **MCP tools** | Model Context Protocol client layer — builtin tools plus any number of stdio or HTTP MCP servers |

---

## 🎯 Upstreams: read this first

The proxy is only as good as the entitlement behind it.

| Upstream | Status | Credential file | Use it when |
|---|---|---|---|
| **`antigravity`** (default) | ✅ Working | `~/.gemini/antigravity_oauth_creds.json` | You want completions today. Serves Gemini 3.x/2.5, Claude and gpt-oss ids. |
| **`code-assist`** (`--upstream code-assist`) | ⚠️ Retired by Google for individuals | `~/.gemini/oauth_creds.json` | Your GCP project actually holds Code Assist **Standard/Enterprise** licenses. |

The free Code Assist tier that Gemini CLI used has been shut down for this OAuth client:
`loadCodeAssist` reports `ineligibleTiers=[free-tier:UNSUPPORTED_CLIENT]` and generation returns
`403 PERMISSION_DENIED / SUBSCRIPTION_REQUIRED`. The Antigravity upstream uses a different OAuth
client plus the `cclog` + `experimentsandconfigs` scopes, which is what unlocks the working tier.
Refresh tokens are client-bound, so the two paths cannot share credentials — each upstream signs in
and caches separately, and switching never disturbs the other's file.

---

## 🚀 Quick start

```bash
git clone https://github.com/nurujjamanpollob/gemini-cli-proxy.git
cd gemini-cli-proxy
npm install
npm run build
node dist/index.js            # first run opens Google sign-in in your browser
```

Development mode (no build step):

```bash
npm run dev                   # ts-node loader, same flags
```

Global install:

```bash
npm install -g github:nurujjamanpollob/gemini-cli-proxy
gemini-cli-proxy --port 3456
```

On first launch the proxy opens `accounts.google.com`; approve once and restarts are silent.
Headless machines: `--disable-browser-auth` prints the URL and accepts the code pasted into the
terminal (a TTY is required for that path; with a browser attached the loopback callback wins).

### Endpoints

| Surface | URL |
|---|---|
| **OpenAI base** | `http://localhost:3456/openai` — **no `/v1` segment** |
| Chat completions | `POST http://localhost:3456/openai/chat/completions` |
| Models | `GET http://localhost:3456/openai/models` |
| **Anthropic base** | `http://localhost:3456/anthropic` (keeps `/v1`) |
| Messages | `POST http://localhost:3456/anthropic/v1/messages` |
| Models | `GET http://localhost:3456/anthropic/v1/models` |
| Health | `GET http://localhost:3456/health` |

> ⚠️ `/openai/v1/chat/completions` returns **404**. The OpenAI router is mounted at `/openai`; only the Anthropic router carries `/v1`.

**Authentication:** none. Authorization happens upstream through Google OAuth, so every client
needs a *non-empty* API key string that the proxy ignores — `not-needed` works everywhere. Bind to
localhost or put your own auth in front before exposing it.

---

## 💬 Chat console (`/ui`)

Open `http://localhost:8787/ui` after starting the proxy. Static assets only — no build step, no
framework, no external CDN.

- **Sessions** persist to `data/sessions.json` (gitignored) and survive restarts; rename or delete
  them from the sidebar.
- **Streaming** uses one SSE event per protocol message: `session`, `round`, `thinking_start`,
  `thinking_chunk`, `token`, `tool_start`, `tool_end`, `message`, `usage`, `error`, `done`.
- **Reasoning** from `-thinking` models renders in a collapsible block above the answer.
- **Tool activity** appears as cards with arguments, output, duration and error state; the model's
  final answer arrives only after every tool round settles.
- **Controls**: model picker (live catalogue), per-tool toggles, system prompt editor, Stop button,
  `Ctrl+Enter` to send.

API used by the console (same-origin, no auth):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/chat/api/tools` | connected MCP servers and exposed tool ids |
| `GET` | `/chat/api/sessions` | session summaries |
| `POST` | `/chat/api/sessions` | create a session |
| `GET` · `PATCH` · `DELETE` | `/chat/api/sessions/:id` | read / rename / delete one session |
| `POST` | `/chat/api/stream` | run a turn (SSE) |

```bash
curl -N localhost:8787/chat/api/stream \
  -H 'content-type: application/json' \
  -d '{"message":"Use the calculate tool for (17+28)*3","tools":["core__calculate"]}'
```

---

## 🧰 MCP tools

The proxy is an **MCP client**: it connects to configured servers at startup, pools their tools and
lets the upstream model call them mid-conversation. Nothing else in the request path changes.

**Config discovery order** (first hit wins; a missing file only logs a warning):

1. `--mcp-config <path>`
2. `PROXY_MCP_CONFIG` environment variable
3. `./mcp.config.json`
4. `~/.gemini/mcp.config.json`

```bash
cp mcp.config.example.json mcp.config.json   # then edit
```

```jsonc
{
  "servers": {
    // stdio: the proxy spawns and owns the process
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "timeoutMs": 30000
    },
    // http / streamable-http: connect to an already running server
    "search": {
      "type": "http",
      "url": "http://127.0.0.1:3845/mcp",
      "headers": {"authorization": "Bearer ${SEARCH_TOKEN}"}
    }
  }
}
```

| Field | Applies to | Notes |
|-------|-----------|-------|
| `type` | all | `stdio` (default), `http`, `streamable-http`; `inprocess` is reserved for builtins |
| `command`, `args`, `env`, `cwd` | stdio | `${VAR}` expands from the proxy's environment |
| `url`, `headers` | http | same expansion, applied to header values |
| `include`, `exclude` | all | filter by raw tool name; `include` wins over `exclude` |
| `disabled` | all | skip the server entirely |
| `timeoutMs` | all | per-call deadline (default 60s) |

A builtin `core` server (in-process, no subprocess) is always registered: `core__time_now`,
`core__calculate`, `core__text_stats`. Tools are exposed to models as `server__tool`; the chat
console lists every connected server and tool with its state.

> **Security**: stdio servers run with the proxy's privileges and can be given any environment
> variable, so review `command`/`args` before enabling a third-party server. `${VAR}` expansion
> reads the *proxy's* environment — pass secrets explicitly rather than exporting them broadly.
## 🤖 Models

Ask the server, don't trust any README (including this one) — the backend rewrites its ids between
releases:

```bash
curl -s http://localhost:3456/openai/models | jq -r '.data[].id'
```

Catalogue verified **2026-11-19** against a live account (both hosts unless noted):

| Family | Ids |
|---|---|
| Gemini 3.8 | `gemini-3.8-flash-high`, `gemini-3.8-flash-tiered`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low` |
| Gemini 4 (daily host only) | `gemini-4-hydrogen-sonar` |
| Gemini 3 flash line | `gemini-3-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-3.1-flash-image` |
| Gemini 2.5 | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-thinking`, `gemini-2.5-flash-lite` |
| Claude | `claude-opus-4-6-thinking`, `claude-sonnet-4-6` |
| Open-weight | `gpt-oss-120b-medium` |

Backend-internal entries (`tab_*`, `chat_*`, `*-disabled`, embedding/rerank) are filtered out and
return `404` if forced.

### How a requested name is resolved

1. **Exact live id** wins — this is how daily-only and image tiers are reached.
2. Otherwise the name is classified into a bucket: `opus`, `sonnet` (any Claude/Haiku/GPT-4/o-series),
   `pro` (`pro|max|high`), `lite` (`lite|mini|-low`), `flash` (`flash|fast|turbo`). A curated alias
   table covers the common legacy names (`gemini-2.5-pro`, `gemini-3.1-pro-preview`, `gpt-4o`, …).
3. The bucket's preference order is applied against the live catalogue; unknown names degrade to the
   `pro` bucket rather than erroring.
4. **Thinking budget** suffix still works: `gemini-2.5-flash[512k]`, `claude-opus-4-6-thinking[1m]`.

Image tiers are deliberately excluded from every preference list, so aliases never route into them by
accident — select `gemini-3.1-flash-image` explicitly if that is what you want.

Upstream `displayName` values are unreliable (several distinct models report the same label), which is
why the OpenAI surface exposes ids and `owned_by` only.

---

## ⚙️ Configuration

```bash
node dist/index.js [options]
npm run dev -- [options]        # development
gemini-cli-proxy [options]      # global install
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --port <port>` | Server port | `3456` |
| `--upstream <provider>` | `antigravity` \| `code-assist` | `antigravity` |
| `-g, --google-cloud-project <id>` | Quota project override (skip discovery) | auto-discovered |
| `--disable-browser-auth` | Code-paste auth instead of browser callback | `false` |
| `--disable-google-search` | Disables the native Google Search tool | `false` |
| `--disable-auto-model-switch` | Disables rate-limit model switching (Code Assist path) | `false` |

### Environment variables

| Variable | Effect |
|---|---|
| `UPSTREAM_PROVIDER` | Default for `--upstream` (`antigravity` unless set to `code-assist`) |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID` | Quota project; skips `loadCodeAssist` discovery |
| `ANTIGRAVITY_AUTH_TIMEOUT_SECONDS` | How long the OAuth callback wait lasts (default `600`) |
| `ANTIGRAVITY_CATALOGUE_TIMEOUT_MS` | Per-host budget for `fetchAvailableModels` (default `15000`); a stalled host can never wedge `/models` |
| `ANTIGRAVITY_FALLBACK_PROJECT` | Last-resort project when discovery and onboarding both fail |
| `ANTIGRAVITY_CLIENT_VERSION`, `ANTIGRAVITY_IDE_VERSION` | Client version strings the backend gates model visibility on |
| `ANTIGRAVITY_KEEP_SYSTEM_INSTRUCTION` | Forward system prompts as a system turn instead of inlining them |
| `OAUTH_CALLBACK_PORT`, `OAUTH_CALLBACK_HOST` | Loopback callback override for the Code Assist flow |
| `NO_BROWSER`, `CI` | Suppress browser launch; fall back to manual code entry |

---

## 🛠️ Integration examples

### curl

```bash
curl -s http://localhost:3456/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"hi"}]}'
```

### OpenAI SDK (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3456/openai", api_key="***")
reply = client.chat.completions.create(
    model="gemini-3.8-flash-high",
    messages=[{"role": "user", "content": "hi"}],
)
```

### Claude Code

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "not-needed",
    "ANTHROPIC_BASE_URL": "http://localhost:3456/anthropic",
    "ANTHROPIC_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6-thinking",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3.1-flash-lite"
  }
}
```

### Aider

```bash
export OPENAI_API_BASE=http://localhost:3456/openai
export OPENAI_API_KEY=***
aider --model gemini-3.8-flash-high
```

### Zed

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:3456/openai",
      "available_models": [
        { "name": "gemini-3.8-flash-high", "display_name": "Gemini 3.8 Flash High", "max_tokens": 65536 },
        { "name": "claude-sonnet-4-6", "display_name": "Claude Sonnet 4.6", "max_tokens": 64000 }
      ]
    }
  }
}
```

### Continue.dev

```json
{
  "models": [
    {
      "title": "Gemini via Antigravity",
      "provider": "openai",
      "model": "gemini-3.8-flash-high",
      "apiBase": "http://localhost:3456/openai",
      "apiKey": "***"
    }
  ]
}
```

---

## 📉 Quota behaviour and fallbacks

- `429` on a model → the request walks the tier chain (same bucket first, then sibling buckets of the same family), up to three attempts. Logs show each hop: `<model> quota exhausted on <host>; trying another tier`.
- Quota is shared across both generation hosts, so retrying the *other* host with the same tier does not help — only a different tier does. Resets are reported by upstream (observed windows of hours for `gemini-2.5-pro`).
- `401` → access token refreshed once and the request replayed.
- `400` → treated as fatal (malformed for that model) and surfaced immediately, never retried.
- Host selection per id is affinity-driven: hosts that listed the id run first, remaining hosts only as last resort.

---

## 🏗️ Development

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with ts-node loader |
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run built server |
| `npm run lint` | ESLint (stylistic + import rules) |
| `npm test` | Vitest suite |
| `npm run test:cov` | Coverage report |

### Layout

```
src/
├── auth/
│   ├── auth.ts                       # Code Assist OAuth (legacy upstream)
│   ├── antigravity-auth.ts           # Antigravity PKCE + loopback callback
│   └── antigravity-token-store.ts    # token persistence / refresh (~/.gemini/antigravity_oauth_creds.json)
├── gemini/
│   ├── client.ts                     # Code Assist API client
│   ├── antigravity-client.ts         # Antigravity client (v1internal SSE, tier chain)
│   ├── antigravity-catalogue-data.ts # static policy: seed ids, buckets, aliases
│   ├── antigravity-catalogue.ts      # live catalogue fetch, union merge, endpoint affinity
│   ├── antigravity-models.ts         # resolution policy + public surface of the component
│   ├── antigravity-request-builder.ts# envelope construction, thinking-budget reconciliation
│   ├── mapper.ts / openai-mapper.ts / anthropic-mapper.ts
│   └── upstream-client.ts            # shared client contract both upstreams implement
├── chat/                             # agent loop, session store/history, SSE event types
├── mcp/                              # config loader, expression parser, builtin tools, tool registry
├── routes/                           # openai.ts, anthropic.ts, chat.ts (console API)
├── types/                            # gemini.ts, openai.ts
└── utils/                            # constant.ts, antigravity-constants.ts, logger.ts, paths.ts, runtime-paths.ts

public/chat/                          # console UI: index.html, css/, js/{api,markdown,render,app}.js
```

### Known issues

- `npm test` currently reports 5 pre-existing failures unrelated to the Antigravity path: four
  `mapJsonSchemaToGemini` `additionalProperties` expectations in `src/gemini/mapper.test.ts` and one
  empty-text expectation in `src/gemini/anthropic-mapper.test.ts`. They fail on a clean checkout of
  `main` too.
- Reasoning text from thinking tiers is merged into normal assistant text on the OpenAI surface
  (`reasoning_content` stays empty). The backend sometimes omits `part.thought`, so parts cannot be
  classified reliably; the fix belongs in `antigravity-client.ts` (signature-based classification).

---

## 🔧 Troubleshooting

**`403 PERMISSION_DENIED` / `SUBSCRIPTION_REQUIRED`** — you are on the retired Code Assist free tier.
Run without `--upstream code-assist`, or point `-g`/`GOOGLE_CLOUD_PROJECT` at a project holding
Code Assist Standard/Enterprise licenses.

**Completions fail after switching upstreams** — credentials are per upstream and client-bound. Delete
the relevant file and sign in again:

```bash
rm ~/.gemini/antigravity_oauth_creds.json     # antigravity upstream
rm ~/.gemini/oauth_creds.json                 # code-assist upstream
```

```powershell
Remove-Item $HOME\.gemini\antigravity_oauth_creds.json   # Windows
```

**`/models` is empty or slow** — both provisioning hosts are unreachable; the proxy falls back to its
seed list (which is why `/models` still answers). Raise `ANTIGRAVITY_CATALOGUE_TIMEOUT_MS` on slow
links and check the `AGY-CATALOGUE` warn lines.

**A model id 404s** — it is not in the live catalogue any more, or it is daily-only and you pinned a
production host. Re-list with `GET /openai/models`.

**Testing from PowerShell looks like a hang** — Windows PowerShell 5.1 `Invoke-WebRequest` uses the
legacy IE engine. Use `curl.exe` or `-UseBasicParsing`; the server itself responds in ~1 s.

**Contributing: push rejected with `GH013`** — GitHub Push Protection flags Google's *published*
installed-app PKCE constants in `src/utils/antigravity-constants.ts`. They are public client
identifiers, not secrets; allow-list them from the secret-scanning "unblock" links GitHub returns, or
disable push protection for the repository.

---

## 📄 License

Apache 2.0 — see [LICENSE](LICENSE).

## 🙏 Acknowledgments

- [Google Gemini](https://deepmind.google/technologies/gemini/) for the models
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) for the authentication flow
- Original project by [uur](https://github.com/uurnik)

---

<div align="center">

**⭐ Star this repo if you find it useful!**

</div>
