/**
 * File-backed chat session store. Sessions are cached in memory and mirrored to
 * `data/chats/<id>.json` so history survives restarts without a database.
 */

import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type {ChatMessageRecord, ChatSession, ChatSessionSummary} from "./types.js";
import {getChatDataDir} from "../utils/runtime-paths.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LOADED_SESSIONS = 250;
export const DEFAULT_TITLE = "New conversation";

function nowIso(): string {
    return new Date().toISOString();
}

/** Derives a session title from the first user message. */
export function deriveTitle(content: string): string {
    const line = content.replace(/\s+/g, " ").trim();
    if (!line) {
        return DEFAULT_TITLE;
    }
    return line.length > 64 ? `${line.slice(0, 61)}...` : line;
}

export class ChatSessionStore {
    private readonly sessions = new Map<string, ChatSession>();
    private loaded = false;

    constructor(private readonly dir: string = getChatDataDir()) {}

    /** Loads persisted sessions once; corrupt files are skipped. */
    load(): void {
        if (this.loaded) {
            return;
        }
        this.loaded = true;

        if (!existsSync(this.dir)) {
            return;
        }

        const files = readdirSync(this.dir)
            .filter((file) => file.endsWith(".json"))
            .sort()
            .slice(-MAX_LOADED_SESSIONS);

        for (const file of files) {
            try {
                const parsed = JSON.parse(readFileSync(path.join(this.dir, file), "utf8")) as ChatSession;
                if (!parsed?.id || !Array.isArray(parsed.messages)) {
                    continue;
                }
                this.sessions.set(parsed.id, {...parsed, messages: parsed.messages ?? []});
            } catch {
                // Ignore unreadable history files rather than failing the request.
            }
        }
    }

    create(model: string, systemPrompt?: string): ChatSession {
        const session: ChatSession = {
            id: crypto.randomUUID(),
            title: DEFAULT_TITLE,
            model,
            messages: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
        };
        if (systemPrompt?.trim()) {
            session.systemPrompt = systemPrompt.trim();
        }

        this.sessions.set(session.id, session);
        this.persist(session);
        return session;
    }

    get(id: string): ChatSession | undefined {
        this.load();
        return SAFE_ID.test(id) ? this.sessions.get(id) : undefined;
    }

    list(): ChatSessionSummary[] {
        this.load();
        return [...this.sessions.values()]
            .map((session) => ({
                id: session.id,
                title: session.title,
                model: session.model,
                messageCount: session.messages.length,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
            }))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }

    /** Appends a message and refreshes title/timestamps. */
    appendMessage(id: string, record: ChatMessageRecord): ChatSession | undefined {
        const session = this.get(id);
        if (!session) {
            return undefined;
        }

        session.messages.push(record);
        session.updatedAt = nowIso();
        if (record.role === "user" && session.title === DEFAULT_TITLE) {
            session.title = deriveTitle(record.content);
        }
        this.persist(session);
        return session;
    }

    /** Applies a mutation to a loaded session and persists it. */
    update(id: string, mutate: (session: ChatSession) => void): ChatSession | undefined {
        const session = this.get(id);
        if (!session) {
            return undefined;
        }
        mutate(session);
        session.updatedAt = nowIso();
        this.persist(session);
        return session;
    }

    remove(id: string): boolean {
        this.load();
        if (!SAFE_ID.test(id)) {
            return false;
        }

        const existed = this.sessions.delete(id);
        const file = path.join(this.dir, `${id}.json`);
        try {
            if (existsSync(file)) {
                rmSync(file, {force: true});
            }
        } catch {
            // Deletion from memory already succeeded; disk cleanup is best-effort.
        }
        return existed;
    }

    private persist(session: ChatSession): void {
        try {
            mkdirSync(this.dir, {recursive: true});
            const target = path.join(this.dir, `${session.id}.json`);
            const temp = `${target}.${process.pid}.tmp`;
            writeFileSync(temp, JSON.stringify(session, null, 2), "utf8");
            renameSync(temp, target);
        } catch {
            // Persistence is best-effort: an in-memory session stays usable.
        }
    }
}
