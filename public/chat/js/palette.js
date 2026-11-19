/* Command palette (Ctrl/Cmd+K): fuzzy search over the commands the app exposes. */

const MAX_VISIBLE = 12;

/**
 * Scores `label` against `query`. Higher wins; 0 means "no match".
 * Prefix > substring > subsequence, with consecutive runs beating scattered characters.
 */
function score(label, query) {
    if (!query) return 1;

    const haystack = label.toLowerCase();
    const needle = query.toLowerCase();
    const at = haystack.indexOf(needle);
    if (at === 0) return 10_000;
    if (at > 0) return 5_000 - at;

    let cursor = 0;
    let total = 0;
    let streak = 0;
    for (const char of needle) {
        const found = haystack.indexOf(char, cursor);
        if (found < 0) return 0;
        streak = found === cursor ? streak + 1 : 1;
        total += streak;
        cursor = found + 1;
    }
    return Math.max(1, total);
}

/**
 * Creates the palette. `getCommands()` is called on every open and render so the list always
 * reflects live state (sessions, models, running turn). Each command: {group, label, hint?, run}.
 */
export function createPalette({getCommands, placeholder = "Type a command…"}) {
    let root = null;
    let input = null;
    let listNode = null;
    let emptyNode = null;
    let visible = [];
    let active = 0;
    let restoreFocusTo = null;

    function build() {
        const overlay = document.createElement("div");
        overlay.className = "palette-overlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Command palette");
        overlay.hidden = true;

        input = document.createElement("input");
        input.className = "palette-input";
        input.type = "text";
        input.placeholder = placeholder;
        input.autocomplete = "off";
        input.spellcheck = false;
        input.setAttribute("aria-label", "Search commands");

        listNode = document.createElement("ul");
        listNode.className = "palette-list";
        listNode.setAttribute("role", "listbox");
        listNode.id = "palette-list";
        input.setAttribute("aria-controls", "palette-list");

        emptyNode = document.createElement("div");
        emptyNode.className = "palette-empty";
        emptyNode.textContent = "no matching command";
        emptyNode.hidden = true;

        const foot = document.createElement("div");
        foot.className = "palette-foot";
        for (const [keys, action] of [["↑↓", "navigate"], ["↵", "run"], ["esc", "close"]]) {
            foot.append(document.createTextNode(" "));
            const kbd = document.createElement("kbd");
            kbd.textContent = keys;
            foot.append(kbd, ` ${action}`);
        }

        const panel = document.createElement("div");
        panel.className = "palette";
        panel.append(input, listNode, emptyNode, foot);

        overlay.append(panel);
        overlay.addEventListener("pointerdown", (event) => {
            if (event.target === overlay) close();
        });

        input.addEventListener("input", () => render(input.value));
        input.addEventListener("keydown", onInputKeydown);

        document.body.append(overlay);
        root = overlay;
    }

    function onInputKeydown(event) {
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                move(1);
                break;
            case "ArrowUp":
                event.preventDefault();
                move(-1);
                break;
            case "Enter":
                event.preventDefault();
                runActive();
                break;
            case "Escape":
                // Consume: the app-level Escape handler must not also fire behind the palette.
                event.preventDefault();
                event.stopPropagation();
                close();
                break;
            default:
                break;
        }
    }

    function render(query) {
        const commands = getCommands() ?? [];
        visible = commands
            .map((command) => ({command, value: score(`${command.group} ${command.label}`, query)}))
            .filter((entry) => entry.value > 0)
            .sort((left, right) => right.value - left.value)
            .slice(0, MAX_VISIBLE)
            .map((entry) => entry.command);

        active = Math.min(active, Math.max(visible.length - 1, 0));
        emptyNode.hidden = visible.length > 0;

        listNode.replaceChildren(
            ...visible.map((command, index) => {
                const item = document.createElement("li");
                item.className = "palette-item";
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", String(index === active));
                item.dataset.index = String(index);

                const group = document.createElement("span");
                group.className = "palette-tag";
                group.textContent = command.group ?? "";

                const label = document.createElement("span");
                label.className = "palette-label";
                label.textContent = command.label;

                const hint = document.createElement("span");
                hint.className = "palette-hint";
                hint.textContent = index === active ? "↵" : command.hint ?? "";

                item.append(group, label, hint);
                item.addEventListener("pointerenter", () => setActive(index));
                item.addEventListener("click", () => {
                    setActive(index);
                    runActive();
                });
                return item;
            }),
        );
    }

    function setActive(index) {
        active = index;
        [...listNode.children].forEach((node, at) => node.setAttribute("aria-selected", String(at === active)));
    }

    function move(delta) {
        if (visible.length === 0) return;
        const next = (active + delta + visible.length) % visible.length;
        setActive(next);
        listNode.children[next]?.scrollIntoView({block: "nearest"});
    }

    function runActive() {
        const command = visible[active];
        close();
        command?.run?.();
    }

    function isOpen() {
        return Boolean(root && !root.hidden);
    }

    function open() {
        if (!root) build();
        restoreFocusTo = document.activeElement;
        root.hidden = false;
        input.value = "";
        active = 0;
        render("");
        input.focus();
        input.select();
    }

    function close() {
        if (!root || root.hidden) return;
        root.hidden = true;
        if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    }

    /** Opens when closed, closes when open (Ctrl/Cmd+K). */
    function toggle() {
        if (isOpen()) close();
        else open();
    }

    return {toggle, open, close, isOpen};
}
