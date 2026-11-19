/* Proxy Console — application wiring: sessions, models, tools, streaming and turn actions. */

import {deleteJson, getJson, rewindSession, streamChat} from "./api.js";
import {createPalette} from "./palette.js";
import {el, sessionItem} from "./render.js";
import {Thread} from "./thread.js";
import {showToast} from "./toast.js";

const PREFS_KEY = "proxy-console:prefs";
const HEALTH_POLL_MS = 30000;
const HINTS = [
    "Call a tool: what time is it in Asia/Dhaka?",
    "Compute (2+3)*sqrt(144) with the calculator tool",
    "Explain what an MCP tool registry does",
];

const state = {
    sessionId: null,
    sessions: [],
    tools: [],
    servers: [],
    enabled: new Set(),
    running: false,
    controller: null,
    /** Persisted record index of the user message being edited; send rewinds to it. */
    pendingRewind: null,
};

const $ = (id) => document.getElementById(id);

const dom = {
    thread: $("thread"),
    welcome: $("welcome"),
    sessions: $("sessions"),
    model: $("model"),
    effort: $("effort"),
    temperature: $("temperature"),
    tempValue: $("temp-value"),
    input: $("input"),
    composer: $("composer"),
    send: $("send"),
    stop: $("stop"),
    newChat: $("new-chat"),
    toolsToggle: $("tools-toggle"),
    toolsPanel: $("tools-panel"),
    toolsBody: $("tools-body"),
    toolCount: $("tool-count"),
    systemToggle: $("system-toggle"),
    systemPanel: $("system-panel"),
    systemPrompt: $("system-prompt"),
    rewindBanner: $("rewind-banner"),
    rewindCancel: $("rewind-cancel"),
    healthDot: $("health-dot"),
    healthText: $("health-text"),
    hints: $("hints"),
};

const thread = new Thread({container: dom.thread, emptyNode: dom.welcome});

/** Palette entries are rebuilt on every open so they always mirror live state. */
const palette = createPalette({getCommands: buildCommands});

/* ---------------- preferences ---------------- */

function loadPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") ?? {};
    } catch {
        return {};
    }
}

function savePrefs(patch) {
    const next = {...loadPrefs(), ...patch};
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
}

/* ---------------- thread helpers ---------------- */

function scrollToBottom() {
    dom.thread.scrollTop = dom.thread.scrollHeight;
}

function showWelcome(visible) {
    dom.welcome.hidden = !visible;
}

function clearThread() {
    thread.clear();
    showWelcome(true);
}

/** Copy / edit / regenerate buttons for a rendered turn. */
function wireTurn(view) {
    view.enableActions({onCopy: copyText, onEdit: beginRewindDraft, onRegenerate: regenerate});
}

/** Only the newest answer keeps its regenerate button. */
function refreshRegenerateAffordances() {
    const latest = thread.lastAssistantView();
    for (const view of thread.views) view.setRegenerateEnabled(view === latest);
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        showToast("copied to clipboard", "success");
    } catch {
        showToast("clipboard unavailable in this context", "error");
    }
}

/* ---------------- sessions ---------------- */

async function refreshSessions() {
    try {
        const data = await getJson("/chat/api/sessions");
        state.sessions = data.sessions ?? [];
        renderSessions();
        const open = state.sessions.find((session) => session.id === state.sessionId);
        thread.syncRecordCount(open?.messageCount);
    } catch (error) {
        console.warn("sessions unavailable", error);
    }
}

function renderSessions() {
    dom.sessions.replaceChildren(
        ...state.sessions.map((session) =>
            sessionItem(session, {active: session.id === state.sessionId, onOpen: openSession, onDelete: deleteSession}),
        ),
    );
}

async function openSession(id) {
    if (state.running) return;
    try {
        const data = await getJson(`/chat/api/sessions/${id}`);
        const records = data.session.messages ?? [];

        state.sessionId = id;
        clearPendingRewind();
        thread.load(records, {model: data.session.model ?? ""});
        for (const view of thread.views) wireTurn(view);
        showWelcome(records.length === 0);
        if (data.session.model) dom.model.value = data.session.model;

        renderSessions();
        refreshRegenerateAffordances();
        scrollToBottom();
    } catch (error) {
        showToast(`could not open session: ${error.message}`, "error");
    }
}

async function deleteSession(id) {
    try {
        await deleteJson(`/chat/api/sessions/${id}`);
        if (state.sessionId === id) {
            state.sessionId = null;
            clearPendingRewind();
            clearThread();
        }
        await refreshSessions();
        showToast("session deleted", "success");
    } catch (error) {
        showToast(`delete failed: ${error.message}`, "error");
    }
}

function startNewConversation() {
    if (state.running) return;
    state.sessionId = null;
    clearPendingRewind();
    clearThread();
    renderSessions();
    dom.input.focus();
}

/* ---------------- models + tools ---------------- */

async function loadModels() {
    const data = await getJson("/openai/models");
    const models = (data.data ?? []).map((model) => model.id).sort();
    const prefs = loadPrefs();
    dom.model.replaceChildren(...models.map((id) => el("option", {value: id, text: id})));
    const fallback = models.includes("gemini-2.5-flash") ? "gemini-2.5-flash" : (models[0] ?? "");
    dom.model.value = prefs.model && models.includes(prefs.model) ? prefs.model : fallback;
}

async function loadTools() {
    const data = await getJson("/chat/api/tools");
    state.tools = data.tools ?? [];
    state.servers = data.servers ?? [];
    dom.toolCount.textContent = String(state.tools.length);

    const prefs = loadPrefs();
    if (Array.isArray(prefs.enabledTools)) {
        state.enabled = new Set(prefs.enabledTools.filter((id) => state.tools.some((tool) => tool.id === id)));
    } else {
        state.enabled = new Set(state.tools.map((tool) => tool.id));
    }

    renderTools();
}

function renderTools() {
    const groups = new Map();
    for (const tool of state.tools) {
        if (!groups.has(tool.serverId)) groups.set(tool.serverId, []);
        groups.get(tool.serverId).push(tool);
    }

    const nodes = [...groups.entries()].map(([serverId, tools]) =>
        el("div", {class: "tool-group"}, [
            el("div", {class: "tool-server", text: `${serverId} · ${tools.length} tool(s)`}),
            ...tools.map((tool) =>
                el("label", {class: "tool-row"}, [
                    el("input", {
                        type: "checkbox",
                        ...(state.enabled.has(tool.id) ? {checked: ""} : {}),
                        onchange: (event) => toggleTool(tool.id, event.target.checked),
                    }),
                    el("span", {}, [
                        el("span", {class: "tool-id", text: tool.id}),
                        el("div", {class: "tool-desc", text: tool.description || "no description"}),
                    ]),
                ]),
            ),
        ]),
    );

    for (const server of state.servers.filter((entry) => entry.state === "failed")) {
        nodes.push(el("div", {class: "tool-group"}, [el("div", {class: "tool-state-bad", text: `${server.id}: ${server.error ?? "unreachable"}`})]));
    }

    dom.toolsBody.replaceChildren(...nodes);
}

function setAllTools(on) {
    state.enabled = on ? new Set(state.tools.map((tool) => tool.id)) : new Set();
    savePrefs({enabledTools: [...state.enabled]});
    renderTools();
}

function toggleTool(id, checked) {
    if (checked) state.enabled.add(id);
    else state.enabled.delete(id);
    savePrefs({enabledTools: [...state.enabled]});
}

/* ---------------- streaming ---------------- */

function setRunning(running) {
    state.running = running;
    dom.send.disabled = running;
    dom.stop.hidden = !running;
    dom.input.setAttribute("aria-busy", String(running));
}

async function sendMessage(text) {
    const message = text.trim();
    if (!message || state.running) return;

    showWelcome(false);
    setRunning(true);

    const turn = thread.beginTurn(message, dom.model.value);
    wireTurn(turn.assistantView);
    refreshRegenerateAffordances();
    scrollToBottom();

    state.controller = new AbortController();

    try {
        await streamChat(
            {
                model: dom.model.value,
                message,
                ...(state.sessionId ? {sessionId: state.sessionId} : {}),
                systemPrompt: dom.systemPrompt.value.trim() || undefined,
                temperature: Number(dom.temperature.value),
                reasoningEffort: dom.effort.value || undefined,
                tools: [...state.enabled],
            },
            (event) => handleEvent(event, turn.assistantView),
            state.controller.signal,
        );
    } catch (error) {
        if (!isAbort(error)) {
            turn.assistantView.setError(String(error.message ?? error));
            showToast("the run failed — details are in the message", "error");
        }
    } finally {
        turn.assistantView.finalize();
        setRunning(false);
        state.controller = null;
        await refreshSessions();
        refreshRegenerateAffordances();
        scrollToBottom();
    }
}

/**
 * Rewinds the persisted transcript to `fromIndex` and re-sends `text`.
 * Shared by regenerate (latest answer) and edit-and-resend (any earlier prompt).
 */
async function resendFrom(fromIndex, text) {
    if (!state.sessionId || state.running) return;

    try {
        await rewindSession(state.sessionId, fromIndex);
    } catch (error) {
        showToast(`could not rewind: ${error.message}`, "error");
        return;
    }

    await openSession(state.sessionId);
    await sendMessage(text);
}

async function regenerate() {
    const view = thread.lastAssistantView();
    if (!view || !state.sessionId) {
        showToast("nothing to regenerate yet", "info");
        return;
    }

    const anchor = thread.exchangeFor(view);
    if (!anchor?.text) {
        showToast("the prompt for that answer is gone", "error");
        return;
    }

    await resendFrom(anchor.index, anchor.text);
}

/** Loads an earlier user message into the composer and arms rewind-on-send. */
function beginRewindDraft(view) {
    if (state.running || view.recordIndex < 0) return;

    state.pendingRewind = view.recordIndex;
    dom.input.value = view.raw;
    autoGrow();
    dom.rewindBanner.hidden = false;
    dom.input.focus();
}

function clearPendingRewind() {
    state.pendingRewind = null;
    dom.rewindBanner.hidden = true;
}

function isAbort(error) {
    return Boolean(error) && (error.name === "AbortError" || String(error.message).includes("abort"));
}

function handleEvent(event, view) {
    switch (event.type) {
        case "session":
            state.sessionId = event.sessionId;
            renderSessions();
            break;
        case "token":
            view.appendToken(event.text);
            scrollToBottom();
            break;
        case "thought":
            view.appendThought(event.text);
            break;
        case "tool_start":
            view.addTool(event.trace);
            scrollToBottom();
            break;
        case "tool_end":
            view.updateTool(event.trace);
            break;
        case "usage":
            view.setUsage(event);
            break;
        case "error":
            view.setError(event.message);
            break;
        default:
            break;
    }
}

/* ---------------- health ---------------- */

async function pingHealth() {
    let online = false;
    try {
        await getJson("/health");
        online = true;
    } catch {
        online = false;
    }

    dom.healthDot.dataset.state = online ? "ok" : "bad";
    const serversUp = state.servers.filter((server) => server.state === "connected").length;
    dom.healthText.textContent = online ? `proxy online${serversUp ? ` · ${serversUp} mcp` : ""}` : "proxy offline";
}

/* ---------------- wiring ---------------- */

function autoGrow() {
    dom.input.style.height = "auto";
    dom.input.style.height = `${Math.min(dom.input.scrollHeight, 220)}px`;
}

function toggleDrawer(button, panel) {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
}

function closeAllDrawers() {
    for (const [button, panel] of [[dom.toolsToggle, dom.toolsPanel], [dom.systemToggle, dom.systemPanel]]) {
        if (!panel.hidden) toggleDrawer(button, panel);
    }
}

function selectModel(model) {
    if (![...dom.model.options].some((option) => option.value === model)) return;
    dom.model.value = model;
    savePrefs({model});
}

function setEffort(effort) {
    dom.effort.value = effort;
    savePrefs({reasoningEffort: effort});
}

function stopRun() {
    state.controller?.abort();
}

/** Every palette entry: sessions, models, reasoning effort, panels, tool toggles, turn actions. */
function buildCommands() {
    const commands = [{group: "session", label: "New conversation", hint: "alt+n", run: startNewConversation}];

    for (const session of state.sessions.slice(0, 24)) {
        if (session.id === state.sessionId) continue;
        commands.push({
            group: "open",
            label: session.title,
            hint: `${session.messageCount ?? 0} msg`,
            run: () => openSession(session.id),
        });
    }

    for (const option of [...dom.model.options]) {
        if (option.value === dom.model.value) continue;
        commands.push({group: "model", label: option.value, hint: "switch", run: () => selectModel(option.value)});
    }

    for (const effort of ["low", "medium", "high"]) {
        if (dom.effort.value === effort) continue;
        commands.push({group: "model", label: `Reasoning effort: ${effort}`, run: () => setEffort(effort)});
    }

    commands.push(
        {group: "panel", label: "Toggle MCP tools", hint: "alt+t", run: () => toggleDrawer(dom.toolsToggle, dom.toolsPanel)},
        {group: "panel", label: "Toggle system prompt", hint: "alt+s", run: () => toggleDrawer(dom.systemToggle, dom.systemPanel)},
        {group: "tools", label: "Enable all tools", run: () => setAllTools(true)},
        {group: "tools", label: "Disable all tools", run: () => setAllTools(false)},
    );

    if (state.running) {
        commands.push({group: "turn", label: "Stop the current run", run: stopRun});
    } else if (thread.lastAssistantView() && state.sessionId) {
        commands.push({group: "turn", label: "Regenerate the last answer", run: regenerate});
    }

    return commands;
}

async function submitComposer() {
    const value = dom.input.value.trim();
    if (!value || state.running) return;

    const rewindFrom = state.pendingRewind;
    dom.input.value = "";
    autoGrow();

    if (rewindFrom !== null) {
        clearPendingRewind();
        await resendFrom(rewindFrom, value);
        return;
    }

    await sendMessage(value);
}

function wireEvents() {
    dom.composer.addEventListener("submit", (event) => {
        event.preventDefault();
        submitComposer();
    });

    dom.input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        // Enter and Ctrl/Cmd+Enter send; Shift+Enter inserts a newline.
        if (event.shiftKey && !event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        submitComposer();
    });
    dom.input.addEventListener("input", autoGrow);

    dom.stop.addEventListener("click", () => state.controller?.abort());
    dom.newChat.addEventListener("click", startNewConversation);
    dom.rewindCancel.addEventListener("click", () => {
        clearPendingRewind();
        dom.input.focus();
    });

    dom.toolsToggle.addEventListener("click", () => toggleDrawer(dom.toolsToggle, dom.toolsPanel));
    dom.systemToggle.addEventListener("click", () => toggleDrawer(dom.systemToggle, dom.systemPanel));
    $("tools-all").addEventListener("click", () => setAllTools(true));
    $("tools-none").addEventListener("click", () => setAllTools(false));

    dom.model.addEventListener("change", () => savePrefs({model: dom.model.value}));
    dom.effort.addEventListener("change", () => savePrefs({reasoningEffort: dom.effort.value}));
    dom.systemPrompt.addEventListener("change", () => savePrefs({systemPrompt: dom.systemPrompt.value}));
    dom.temperature.addEventListener("input", () => {
        dom.tempValue.textContent = Number(dom.temperature.value).toFixed(1);
        savePrefs({temperature: Number(dom.temperature.value)});
    });

    dom.thread.addEventListener("click", (event) => {
        const button = event.target.closest(".copy");
        if (!button) return;
        const code = button.parentElement?.querySelector("code")?.textContent ?? "";
        navigator.clipboard?.writeText(code);
        button.textContent = "copied";
        setTimeout(() => (button.textContent = "copy"), 1200);
    });

    document.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            palette.toggle();
            return;
        }

        if (event.altKey && !event.ctrlKey && !event.metaKey) {
            const actions = {
                n: startNewConversation,
                t: () => toggleDrawer(dom.toolsToggle, dom.toolsPanel),
                s: () => toggleDrawer(dom.systemToggle, dom.systemPanel),
            };
            const action = actions[event.key.toLowerCase()];
            if (!action) return;
            event.preventDefault();
            action();
            return;
        }

        if (event.key !== "Escape") return;
        if (state.pendingRewind !== null) clearPendingRewind();
        closeAllDrawers();
    });
}

async function init() {
    const prefs = loadPrefs();
    dom.temperature.value = prefs.temperature ?? 1;
    dom.tempValue.textContent = Number(dom.temperature.value).toFixed(1);
    dom.effort.value = prefs.reasoningEffort ?? "";
    dom.systemPrompt.value = prefs.systemPrompt ?? "";

    dom.hints.replaceChildren(
        ...HINTS.map((hint) => el("button", {
            class: "hint",
            type: "button",
            text: hint,
            onclick: () => {
                dom.input.value = hint;
                autoGrow();
                dom.input.focus();
            },
        })),
    );

    wireEvents();

    const results = await Promise.allSettled([loadModels(), loadTools(), refreshSessions()]);
    for (const result of results) {
        if (result.status === "rejected") console.error(result.reason);
    }

    await pingHealth();
    setInterval(() => pingHealth(), HEALTH_POLL_MS);
}

init();
