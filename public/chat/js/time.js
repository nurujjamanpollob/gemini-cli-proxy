/* Compact relative timestamps for dense lists ("now", "5m", "3h", "2d", then a date). */

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** Human age for an ISO timestamp; empty string when the value is missing or invalid. */
export function formatRelative(iso) {
    if (!iso) return "";

    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "";

    const delta = Math.max(0, Date.now() - then);
    if (delta < MINUTE_MS) return "now";
    if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m`;
    if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h`;
    if (delta < WEEK_MS) return `${Math.floor(delta / DAY_MS)}d`;

    return new Date(then).toLocaleDateString([], {month: "short", day: "numeric"});
}
