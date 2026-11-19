/**
 * Server-Sent-Events channel used by the chat stream endpoint. Events are
 * single-line JSON payloads (`data: {...}\n\n`) so a browser can parse them with
 * fetch + ReadableStream (EventSource cannot POST).
 */

import type {Response} from "express";

import type {ChatStreamEvent} from "./types.js";

const KEEPALIVE_INTERVAL_MS = 15_000;

export class SseChannel {
    private closed = false;
    private readonly keepAlive: ReturnType<typeof setInterval>;

    constructor(private readonly res: Response) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();

        this.keepAlive = setInterval(() => {
            if (!this.closed) {
                this.res.write(": keep-alive\n\n");
            }
        }, KEEPALIVE_INTERVAL_MS);
    }

    send(event: ChatStreamEvent): void {
        if (this.closed) {
            return;
        }
        this.res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        clearInterval(this.keepAlive);
        this.res.end();
    }
}
