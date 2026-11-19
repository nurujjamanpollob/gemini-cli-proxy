/* DOM builders for the conversation surface. */

import {renderMarkdown} from "./markdown.js";
import {formatRelative} from "./time.js";

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
        /** Position of the matching persisted record; assigned by Thread, -1 while detached. */
        this.recordIndex = -1;

        this.bubble = el("div", {class: "bubble"});
        this.tools = el("div", {class: "tools", hidden: true});
        this.usageNode = el("div", {class: "usage", hidden: true});
        this.thoughtBody = el("div", {"class": "thought-text"});
        this.thought = el("details", {class: "thought", hidden: true}, [el("summary", {text: "reasoning"}), this.thoughtBody]);

        const meta = el("div", {class: "meta", text: [model, formatTime()].filter(Boolean).join("  ·  ")});
        this.actionsNode = el("div", {class: "msg-actions", hidden: true});
        this.body = el("div", {class: "body"}, [meta, this.thought, this.bubble, this.tools, this.usageNode, this.actionsNode]);
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

    /**
     * Renders the per-turn action row. `onCopy` always applies, `onEdit` targets user turns and
     * `onRegenerate` assistant turns; regenerate is hidden for all but the newest answer via
     * setRegenerateEnabled().
     */
    enableActions({onCopy, onEdit, onRegenerate}) {
        const buttons = [actionButton("copy", "Copy this message as text", () => onCopy(this.raw))];

        if (this.role === "user" && onEdit) {
            buttons.push(actionButton("edit", "Edit and resend from here", () => onEdit(this)));
        }
        if (this.role === "assistant" && onRegenerate) {
            this.regenerateButton = actionButton("regenerate", "Rewind and answer again", () => onRegenerate(this));
            buttons.push(this.regenerateButton);
        }

        this.actionsNode.replaceChildren(...buttons);
        this.actionsNode.hidden = false;
    }

    /** Only the newest assistant turn can be regenerated; everything else hides the affordance. */
    setRegenerateEnabled(enabled) {
        if (this.regenerateButton) this.regenerateButton.hidden = !enabled;
    }

    finalize() {
        this.bubble.classList.remove("caret");
        if (!this.raw) this.setText("");
    }
}

function actionButton(label, title, onclick) {
    return el("button", {class: "act", type: "button", title, onclick, text: label});
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

/** Mirrors MAX_TITLE_LENGTH in src/chat/store.ts — the server rejects longer titles. */
const MAX_TITLE_LENGTH = 120;

/**
 * Sidebar row for one session: open it, rename it inline (Enter commits, Escape aborts) or delete it.
 * Action buttons are siblings of the open button rather than descendants, so the markup stays valid.
 */
export function sessionItem(session, {active, onOpen, onDelete, onRename}) {
    const age = `${session.messageCount ?? 0} · ${formatRelative(session.updatedAt)}`;

    const openButton = el(
        "button",
        {
            class: "session-item",
            type: "button",
            dataset: {active: String(active)},
            onclick: () => onOpen(session.id),
        },
        [
            el("span", {class: "title", text: session.title}),
            el("span", {class: "meta", text: age}),
        ],
    );

    const renameButton = el("button", {
        class: "kill rename",
        type: "button",
        title: "Rename session",
        "aria-label": `Rename “${session.title}”`,
        onclick: enterRename,
        text: "✎",
    });

    const deleteButton = el("button", {
        class: "kill",
        type: "button",
        title: "Delete session",
        "aria-label": `Delete “${session.title}”`,
        onclick: () => onDelete(session.id),
        text: "×",
    });
    const actions = el("span", {class: "row-actions"}, [renameButton, deleteButton]);
    const input = el("input", {
        class: "rename-input",
        type: "text",
        value: session.title,
        maxlength: String(MAX_TITLE_LENGTH),
        "aria-label": `New title for “${session.title}”`,
    });

    const form = el("div", {class: "rename-form", hidden: true}, [
        input,
        el("button", {class: "btn btn-tiny", type: "button", text: "save", onclick: () => commit()}),
        el("button", {class: "btn btn-tiny", type: "button", text: "esc", onclick: () => exitRename()}),
    ]);

    function enterRename() {
        openButton.hidden = true;
        actions.hidden = true;
        form.hidden = false;
        input.focus();
        input.select();
    }

    function exitRename() {
        form.hidden = true;
        openButton.hidden = false;
        actions.hidden = false;
    }

    function commit() {
        const title = input.value.trim();
        exitRename();
        if (!title || title === session.title) return;
        Promise.resolve(onRename(session.id, title)).catch(() => undefined);
    }

    input.addEventListener("keydown", (event) => {
        // Keep typing isolated: global shortcuts must not fire while a title is being edited.
        event.stopPropagation();
        if (event.key === "Enter") {
            event.preventDefault();
            commit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            exitRename();
        }
    });

    return el("li", {class: "session-row"}, [
        openButton,
        actions,
        form,
    ]);
}
