/* HTTP + SSE client for the proxy chat API. */

const JSON_HEADERS = {"content-type": "application/json"};

async function errorMessage(response) {
    let detail = response.statusText || "request failed";
    try {
        const body = await response.json();
        if (body && typeof body.error === "string") detail = body.error;
    } catch {
        /* non-JSON error body */
    }
    return `${response.status}: ${detail}`;
}

async function send(method, path, payload) {
    const response = await fetch(path, {
        method,
        headers: JSON_HEADERS,
        ...(payload === undefined ? {} : {body: JSON.stringify(payload ?? {})}),
    });
    if (!response.ok) throw new Error(await errorMessage(response));
    return response.json();
}

export function getJson(path) {
    return send("GET", path);
}

export function postJson(path, payload) {
    return send("POST", path, payload ?? {});
}

export function patchJson(path, payload) {
    return send("PATCH", path, payload ?? {});
}

export function deleteJson(path) {
    return send("DELETE", path);
}

/** Renames a session (sidebar inline rename). */
export function renameSession(id, title) {
    return patchJson(`/chat/api/sessions/${id}`, {title});
}

/** Drops transcript records from `fromIndex` onwards (edit / regenerate flows). */
export function rewindSession(id, fromIndex) {
    return postJson(`/chat/api/sessions/${id}/rewind`, {fromIndex});
}

/** Parses one SSE frame (multi-line `data:` supported, comments ignored). */
function dispatchFrame(frame, onEvent) {
    for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        try {
            onEvent(JSON.parse(raw));
        } catch {
            /* ignore malformed frames */
        }
    }
}

/**
 * POSTs a chat run and streams protocol events.
 * Resolves when the server closes the stream or the signal aborts.
 */
export async function streamChat(payload, onEvent, signal) {
    const response = await fetch("/chat/api/stream", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(payload),
        signal,
    });

    if (!response.ok || !response.body) throw new Error(await errorMessage(response));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, {stream: true});
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            dispatchFrame(buffer.slice(0, boundary), onEvent);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");
        }
    }

    if (buffer.trim()) dispatchFrame(buffer, onEvent);
}
