import {describe, expect, it} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {ChatSessionStore, DEFAULT_TITLE, MAX_TITLE_LENGTH} from "./store.js";
import type {ChatMessageRecord} from "./types.js";

function record(role: "user" | "assistant", content: string): ChatMessageRecord {
    return {id: crypto.randomUUID(), role, content, createdAt: new Date().toISOString()};
}

/** Store backed by a throwaway directory; the path is returned so tests can re-open it. */
function freshStore(label: string): {store: ChatSessionStore; dir: string} {
    const dir = path.join(os.tmpdir(), `chat-store-test-${label}-${crypto.randomUUID()}`);
    fs.rmSync(dir, {recursive: true, force: true});
    return {store: new ChatSessionStore(dir), dir};
}

describe("ChatSessionStore.rename", () => {
    it("collapses whitespace and persists the new title", () => {
        const {store, dir} = freshStore("rename-persist");
        const session = store.create("test-model");

        expect(store.rename(session.id, "  quarterly   plan  ")?.title).toBe("quarterly plan");
        expect(new ChatSessionStore(dir).get(session.id)?.title).toBe("quarterly plan");
    });

    it("rejects blank and oversized titles without touching the session", () => {
        const {store} = freshStore("rename-invalid");
        const session = store.create("test-model");

        expect(store.rename(session.id, "   ")).toBeUndefined();
        expect(store.rename(session.id, "x".repeat(MAX_TITLE_LENGTH + 1))).toBeUndefined();
        expect(store.get(session.id)?.title).toBe(DEFAULT_TITLE);
    });

    it("returns undefined for an unknown session", () => {
        const {store} = freshStore("rename-missing");
        expect(store.rename("does-not-exist", "anything")).toBeUndefined();
    });
});

describe("ChatSessionStore.rewindTo", () => {
    it("drops every record from the index onwards and persists it", () => {
        const {store, dir} = freshStore("rewind");
        const session = store.create("test-model");
        for (const message of [record("user", "one"), record("assistant", "two"), record("user", "three")]) {
            store.appendMessage(session.id, message);
        }

        expect(store.rewindTo(session.id, 1)?.messages.map((message) => message.content)).toEqual(["one"]);
        expect(new ChatSessionStore(dir).get(session.id)?.messages).toHaveLength(1);
    });

    it("accepts the transcript length as a no-op boundary and zero as an empty transcript", () => {
        const {store} = freshStore("rewind-boundaries");
        const session = store.create("test-model");
        store.appendMessage(session.id, record("user", "hello"));

        expect(store.rewindTo(session.id, 1)?.messages).toHaveLength(1);
        expect(store.rewindTo(session.id, 0)?.messages).toHaveLength(0);
    });

    it("rejects out-of-range and non-integer indices", () => {
        const {store} = freshStore("rewind-invalid");
        const session = store.create("test-model");
        store.appendMessage(session.id, record("user", "hello"));

        expect(store.rewindTo(session.id, 2)).toBeUndefined();
        expect(store.rewindTo(session.id, -1)).toBeUndefined();
        expect(store.rewindTo(session.id, 0.5)).toBeUndefined();
        expect(store.rewindTo(session.id, Number.NaN)).toBeUndefined();
        expect(store.get(session.id)?.messages).toHaveLength(1);
    });

    it("returns undefined for an unknown session", () => {
        const {store} = freshStore("rewind-missing");
        expect(store.rewindTo("nope", 0)).toBeUndefined();
    });
});
