/* Proxy Console — application wiring (sessions, models, tools, streaming). */

import {getJson, streamChat} from "./api.js";
import {el, MessageView, sessionItem} from "./render.js";

const PREFS_KEY = "proxy-console:prefs";
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
    healthDot: $("health-dot"),
    healthText: $("health-text"),
    hints: $("hints"),
};

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

function scrollToBottom() {
    dom.thread.scrollTop = dom.thread.scrollHeight;
}

function clearThread() {
    dom.thread.replaceChildren();
    dom.thread.append(dom.welcome);
    dom.welcome.hidden = false;
}

function hideWelcome() {
    if (!dom.welcome.hidden) dom.welcome.hidden = true;
}

/* ---------------- sessions ---------------- */

async function refreshSessions() {
    try {
        const data = await getJson("/chat/api/sessions");
        state.sessions = data.sessions ?? [];
        renderSessions();
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
        state.sessionId = id;
        renderSessions();
        clearThread();
        hideWelcome();

        for (const record of data.session.messages ?? []) {
            const view = new MessageView(record.role, {model: record.model ?? ""});
            view.setText(record.content ?? "");
            if (record.thought) view.appendThought(record.thought);
            for (const trace of record.traces ?? []) view.addTool(trace).update(trace);
            dom.thread.append(view.root);
        }

        if (data.session.model) dom.model.value = data.session.model;
        scrollToBottom();
    } catch (error) {
        console.error(error);
    }
}

async function deleteSession(id) {
    try {
        await fetch(`/chat/api/sessions/${id}`, {method: "DELETE"});
        if (state.sessionId === id) {
            state.sessionId = null;
            clearThread();
        }
        await refreshSessions();
    } catch (error) {
        console.error(error);
    }
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

    hideWelcome();
    setRunning(true);

    const userView = new MessageView("user");
    userView.setText(message);
    dom.thread.append(userView.root);

    const assistant = new MessageView("assistant", {model: dom.model.value});
    dom.thread.append(assistant.root);
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
            (event) => handleEvent(event, assistant),
            state.controller.signal,
        );
    } catch (error) {
        if (!isAbort(error)) assistant.setError(String(error.message ?? error));
    } finally {
        assistant.finalize();
        setRunning(false);
        state.controller = null;
        await refreshSessions();
        scrollToBottom();
    }
}

function isAbort(error) {
    return error && (error.name === "AbortError" || String(error.message).includes("abort"));
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

function init() {
    const prefs = loadPrefs();
    dom.temperature.value = prefs.temperature ?? 1;
    dom.tempValue.textContent = Number(dom.temperature.value).toFixed(1);
    dom.effort.value = prefs.reasoningEffort ?? "";
    dom.systemPrompt.value = prefs.systemPrompt ?? "";

    dom.hints.replaceChildren(...HINTS.map((hint) => el("button", {class: "hint", type: "button", text: hint, onclick: () => {
        dom.input.value = hint;
        autoGrow();
        dom.input.focus();
    }})));

    dom.composer.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = dom.input.value;
        dom.input.value = "";
        autoGrow();
        sendMessage(value);
    });

    dom.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            dom.composer.requestSubmit();
        }
    });
    dom.input.addEventListener("input", autoGrow);

    dom.stop.addEventListener("click", () => state.controller?.abort());
    dom.newChat.addEventListener("click", () => {
        if (state.running) return;
        state.sessionId = null;
        renderSessions();
        clearThread();
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

    checkHealth();
    loadModels().catch((error) => console.error(error));
    loadTools().catch((error) => console.error(error));
    refreshSessions();
}

function setAllTools(on) {
    state.enabled = on ? new Set(state.tools.map((tool) => tool.id)) : new Set();
    savePrefs({enabledTools: [...state.enabled]});
    renderTools();
}

async function checkHealth() {
    try {
        await getJson("/health");
        dom.healthDot.dataset.state = "ok";
        const serversUp = state.servers.filter((server) => server.state === "connected").length;
        dom.healthText.textContent = `proxy online${serversUp ? ` · ${serversUp} mcp` : ""}`;
    } catch {
        dom.healthDot.dataset.state = "bad";
        dom.healthText.textContent = "proxy offline";
    }
}

init();
