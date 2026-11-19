/* DOM builders for the conversation surface. */

import {renderMarkdown} from "./markdown.js";

export function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null) continue;
        if (key === "class") node.className = value;
        else if (key === "html") node.innerHTML = value;
        else if (key === "text") node.textContent = String(value);
        else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === "dataset") Object.assign(node.dataset, value);
        else node.setAttribute(key, String(value));
    }
    for (const child of [].concat(children)) {
        if (child === null || child === undefined) continue;
        node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
}

function avatarFor(role) {
    return el("div", {class: "avatar", text: role === "user" ? "you" : "ai"});
}

function formatTime(date = new Date()) {
    return date.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
}

/** Live assistant/user turn view. */
export class MessageView {
    constructor(role, {model = ""} = {}) {
        this.role = role;
        this.raw = "";
        this.thoughtText = "";
        this.toolNodes = new Map();

        this.bubble = el("div", {class: "bubble"});
        this.tools = el("div", {class: "tools", hidden: true});
        this.usageNode = el("div", {class: "usage", hidden: true});
        this.thoughtBody = el("div", {"class": "thought-text"});
        this.thought = el("details", {class: "thought", hidden: true}, [el("summary", {text: "reasoning"}), this.thoughtBody]);

        const meta = el("div", {class: "meta", text: [model, formatTime()].filter(Boolean).join("  ·  ")});
        this.body = el("div", {class: "body"}, [meta, this.thought, this.bubble, this.tools, this.usageNode]);
        this.root = el("div", {class: "msg", dataset: {role}}, [avatarFor(role), this.body]);

        if (role === "user") this.setText(this.raw);
    }

    setText(text) {
        this.raw = text ?? "";
        if (this.role === "user") {
            this.bubble.textContent = this.raw;
            return;
        }
        this.bubble.innerHTML = renderMarkdown(this.raw);
    }

    appendToken(text) {
        this.setText(this.raw + text);
        this.bubble.classList.add("caret");
    }

    appendThought(text) {
        this.thoughtText += text;
        this.thought.hidden = false;
        this.thoughtBody.textContent = this.thoughtText;
    }

    setError(message) {
        this.body.append(el("div", {class: "error-card", text: message}));
    }

    setUsage(usage) {
        this.usageNode.hidden = false;
        this.usageNode.textContent = `tokens ${usage.promptTokens} in · ${usage.completionTokens} out · ${usage.totalTokens} total`;
    }

    addTool(trace) {
        this.tools.hidden = false;
        const card = new ToolCard(trace);
        this.toolNodes.set(trace.id, card);
        this.tools.append(card.root);
        return card;
    }

    updateTool(trace) {
        const card = this.toolNodes.get(trace.id);
        if (card) card.update(trace);
        else this.addTool(trace);
    }

    finalize() {
        this.bubble.classList.remove("caret");
        if (!this.raw) this.setText("");
    }
}

/** Collapsible MCP tool invocation card. */
export class ToolCard {
    constructor(trace) {
        this.trace = trace;
        this.argsNode = el("pre", {class: "tool-pre", text: JSON.stringify(trace.arguments ?? {}, null, 2)});
        this.outputNode = el("pre", {class: "tool-pre", hidden: true});
        this.stateNode = el("span", {class: "state", dataset: {status: trace.status}, text: trace.status});
        this.timeNode = el("span", {class: "tool-time"});

        this.detail = el("div", {class: "tool-detail"}, [
            el("div", {}, [el("div", {class: "tool-label", text: "arguments"}), this.argsNode]),
            el("div", {}, [el("div", {class: "tool-label", text: "result"}), this.outputNode]),
        ]);

        this.head = el("div", {class: "tool-head", onclick: () => this.toggle()}, [
            this.stateNode,
            el("span", {class: "tool-name", text: trace.toolId}),
            this.timeNode,
        ]);

        this.root = el("details", {class: "tool-card"}, [this.head]);
        this.detail.hidden = true;
        this.root.append(this.detail);
        this.apply(trace);
    }

    toggle() {
        const open = !this.detail.hidden;
        this.detail.hidden = open;
    }

    apply(trace) {
        this.stateNode.dataset.status = trace.status;
        this.stateNode.textContent = trace.status;

        if (trace.endedAt && trace.startedAt) {
            this.timeNode.textContent = `${(((trace.endedAt - trace.startedAt) / 1000)).toFixed(2)}s`;
        } else if (trace.status === "running") {
            this.timeNode.textContent = "running…";
        }

        const payload = trace.status === "error" ? trace.error ?? "" : trace.output ?? "";
        if (payload) {
            this.outputNode.hidden = false;
            this.outputNode.textContent = payload;
        } else if (trace.status !== "running") {
            this.outputNode.hidden = false;
            this.outputNode.textContent = "(no output)";
        }
    }

    update(trace) {
        this.trace = trace;
        this.apply(trace);
    }
}

export function sessionItem(session, {active, onOpen, onDelete}) {
    return el("li", {}, [
        el(
            "button",
            {
                class: "session-item",
                type: "button",
                dataset: {active: String(active)},
                onclick: () => onOpen(session.id),
            },
            [
                el("span", {class: "title", text: session.title}),
                el("span", {class: "meta", text: String(session.messageCount ?? 0)}),
                el("button", {
                    class: "kill",
                    type: "button",
                    title: "Delete session",
                    onclick: (event) => {
                        event.stopPropagation();
                        onDelete(session.id);
                    },
                    text: "×",
                }),
            ],
        ),
    ]);
}
