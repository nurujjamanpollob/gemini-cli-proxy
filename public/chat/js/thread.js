/* Thread controller: renders persisted transcripts, tracks record indices and rewind anchors. */

import {MessageView} from "./render.js";

/**
 * Owns the ordered list of rendered turns inside the thread container.
 *
 * Every view carries `recordIndex`, the position of its persisted record in the session
 * transcript, which is what `/chat/api/sessions/:id/rewind` expects.
 */
export class Thread {
    constructor({container, emptyNode = null}) {
        this.container = container;
        this.emptyNode = emptyNode;
        this.views = [];
        /** Next free persisted-record index (bumped optimistically while a turn streams). */
        this.nextIndex = 0;
    }

    /** Replaces the DOM with a freshly loaded transcript. */
    load(records, {model = ""} = {}) {
        const list = records ?? [];
        this.views = [];
        if (this.emptyNode) this.container.replaceChildren(this.emptyNode);
        else this.container.replaceChildren();

        for (const [index, record] of list.entries()) {
            const view = new MessageView(record.role, {model: record.model ?? model});
            view.setText(record.content ?? "");
            if (record.thought) view.appendThought(record.thought);
            for (const trace of record.traces ?? []) view.addTool(trace).update(trace);
            view.recordIndex = index;
            this.views.push(view);
            this.container.append(view.root);
        }

        this.nextIndex = this.views.length;
        return this.views;
    }

    /** Empties the thread, keeping the welcome node available for the caller. */
    clear() {
        this.load([]);
    }

    /** Appends a user turn plus its streaming assistant placeholder. */
    beginTurn(userText, model) {
        const userView = this.#append(new MessageView("user"));
        userView.setText(userText);
        const assistantView = this.#append(new MessageView("assistant", {model}));
        return {userIndex: userView.recordIndex, userView, assistantView};
    }

    #append(view) {
        view.recordIndex = this.nextIndex;
        this.nextIndex += 1;
        this.views.push(view);
        this.container.append(view.root);
        return view;
    }

    /** Newest assistant turn, or null when nothing has been answered yet. */
    lastAssistantView() {
        for (let index = this.views.length - 1; index >= 0; index -= 1) {
            if (this.views[index].role === "assistant") return this.views[index];
        }
        return null;
    }

    /**
     * The user turn that produced `view`: its persisted index plus text. Rewinding to that
     * index and re-sending the text replays exactly one exchange.
     */
    exchangeFor(view) {
        const at = this.views.indexOf(view);
        if (at < 0) return null;

        for (let index = at; index >= 0; index -= 1) {
            const candidate = this.views[index];
            if (candidate.role === "user") return {index: candidate.recordIndex, text: candidate.raw};
        }
        return null;
    }

    /** Applies an authoritative record count from a session summary. */
    syncRecordCount(count) {
        if (Number.isInteger(count)) this.nextIndex = Math.max(this.nextIndex, count);
    }
}
