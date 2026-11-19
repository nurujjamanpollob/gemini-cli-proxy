/* Transient bottom-centre notifications (no dependencies, aria-polite stack). */

const TONE_CLASS = {info: "tone-info", success: "tone-ok", error: "tone-bad"};
const LIFETIME_MS = 2600;
const EXIT_MS = 220;

let layer = null;

function ensureLayer() {
    if (layer && document.body.contains(layer)) return layer;

    layer = document.createElement("div");
    layer.className = "toast-layer";
    layer.setAttribute("role", "status");
    layer.setAttribute("aria-live", "polite");
    document.body.append(layer);
    return layer;
}

/** Shows `message` briefly. `tone` is one of info | success | error. */
export function showToast(message, tone = "info") {
    const node = document.createElement("div");
    node.className = `toast ${TONE_CLASS[tone] ?? TONE_CLASS.info}`;
    node.textContent = message;

    ensureLayer().append(node);
    requestAnimationFrame(() => node.classList.add("in"));

    setTimeout(() => {
        node.classList.remove("in");
        setTimeout(() => node.remove(), EXIT_MS);
    }, LIFETIME_MS);
}
