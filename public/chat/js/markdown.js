/* Minimal, XSS-safe markdown renderer (no external dependencies). */

const ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function safeUrl(raw) {
    const url = String(raw || "").trim();
    return /^(https?:|mailto:|#|\/)/i.test(url) ? url : "#";
}

/** Inline spans: `code`, **bold**, *italic*, [links](url). Input must be escaped. */
function renderInline(escaped) {
    const codes = [];
    let html = escaped.replace(/`([^`\n]+)`/g, (_match, body) => {
        codes.push(body);
        return `\uE000${codes.length - 1}\uE000`;
    });

    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    html = html.replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_match, label, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );
    html = html.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

    return html.replace(/\uE000(\d+)\uE000/g, (_match, index) => `<code class="inline">${codes[Number(index)]}</code>`);
}

function renderCodeBlock(code, lang) {
    const label = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
    return (
            `<div class="codeblock"${label}>` +
    `<button class="btn btn-tiny copy" type="button">copy</button>` +
    `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>` +
    "</div>"
    );
}

function isListItem(line) {
    return /^\s*[-*+]\s+/.test(line);
}

function isOrderedItem(line) {
    return /^\s*\d+[.)]\s+/.test(line);
}

/** Block level pass over escaped markdown text. */
function renderBlocks(source) {
    const lines = source.split("\n");
    const out = [];
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        out.push(`<p>${renderInline(paragraph.join(" ")).replace(/ /g, " ")}</p>`);
        paragraph = [];
    };

    while (index < lines.length) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!trimmed) {
            flushParagraph();
            index++;
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (heading) {
            flushParagraph();
            const level = Math.min(heading[1].length + 1, 4);
            out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
            index++;
            continue;
        }

        if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
            flushParagraph();
            out.push("<hr />");
            index++;
            continue;
        }

        if (trimmed.startsWith(">")) {
            flushParagraph();
            const quote = [];
            while (index < lines.length && lines[index].trim().startsWith(">")) {
                quote.push(lines[index].trim().replace(/^>\s?/, ""));
                index++;
            }
            out.push(`<blockquote>${renderInline(escapeHtml(quote.join(" ")))}</blockquote>`);
            continue;
        }

        if (isListItem(trimmed) || isOrderedItem(trimmed)) {
            flushParagraph();
            const ordered = isOrderedItem(trimmed);
            const items = [];
            while (index < lines.length) {
                const current = lines[index];
                const matches = ordered ? isOrderedItem(current) : isListItem(current);
                if (!matches || current.trim() === "") break;
                items.push(renderInline(escapeHtml(current.trim().replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))));
                index++;
            }
            const tag = ordered ? "ol" : "ul";
            out.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
            continue;
        }

        paragraph.push(trimmed);
        index++;
    }

    flushParagraph();
    return out.join("");
}

/** Converts markdown to sanitized HTML. Fenced code blocks are never parsed inline. */
export function renderMarkdown(source) {
    const text = String(source ?? "");
    if (!text.trim()) return "";

    const fence = /```([\w+.#-]*)\r?\n?([\s\S]*?)```/g;
    const chunks = [];
    let cursor = 0;
    let match = fence.exec(text);

    while (match) {
        if (match.index > cursor) chunks.push({kind: "md", text: text.slice(cursor, match.index)});
        chunks.push({kind: "code", lang: match[1] || "", code: match[2]});
        cursor = match.index + match[0].length;
        match = fence.exec(text);
    }

    if (cursor < text.length) chunks.push({kind: "md", text: text.slice(cursor)});

    return chunks.map((chunk) => (chunk.kind === "code" ? renderCodeBlock(chunk.code, chunk.lang) : renderBlocks(escapeHtml(chunk.text)))).join("");
}
