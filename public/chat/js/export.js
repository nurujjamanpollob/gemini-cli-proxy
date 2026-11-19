/* Client-side session export: transcript -> Markdown string, plus a download helper. */

const ROLE_LABELS = {user: "You", assistant: "Model", system: "System"};

/** Fenced code block that survives content containing backticks. */
function fence(content, language) {
    const text = String(content ?? "").replace(/\s+$/, "");
    const marker = text.includes("```") ? "~~~~" : "```";
    return [`${marker}${language}`, ...text.split("\n"), marker];
}

/** "2026-11-19 19:46 UTC" — stable, locale-independent stamp for exported headers. */
function formatStamp(iso) {
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "unknown";
    return `${new Date(then).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** File-name safe slug; keeps letters/digits/dashes and stays short. */
export function slugify(value) {
    const slug = String(value ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
    return slug || "conversation";
}

/** Full transcript as Markdown: header block, then one section per persisted record. */
export function sessionToMarkdown(session) {
    const records = session.messages ?? [];
    const lines = [
        `# ${session.title || "Untitled conversation"}`,
        "",
        `- model: \`${session.model ?? "unknown"}\``,
        `- created: ${formatStamp(session.createdAt)}`,
        `- updated: ${formatStamp(session.updatedAt)}`,
        `- messages: ${records.length}`,
        "",
    ];

    for (const record of records) {
        lines.push("---", "", `## ${ROLE_LABELS[record.role] ?? record.role}`, "");

        if (record.thought) {
            lines.push(...String(record.thought).split("\n").map((line) => `> ${line}`), "");
        }

        const content = String(record.content ?? "").trim();
        lines.push(content || "_(empty)_", "");

        for (const trace of record.traces ?? []) {
            const label = trace.toolId ?? trace.name ?? "tool";
            lines.push(`### tool · ${label}`, "");
            if (trace.status === "error") lines.push(`**failed:** ${trace.error ?? "unknown error"}`, "");

            if (trace.arguments) lines.push(...fence(trace.arguments, "json"), "");
            if (trace.output) lines.push(...fence(trace.output, "text"), "");
        }
    }

    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/** Triggers a browser download for `filename` with the given text. */
export function downloadText(filename, text) {
    const url = URL.createObjectURL(new Blob([text], {type: "text/markdown;charset=utf-8"}));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Give the click a tick to start the transfer before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
