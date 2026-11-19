/**
 * Runtime path resolution that works identically for `src` (ts-node dev) and
 * `dist` (built) entry points, including global/npx installs.
 */

import {existsSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

let cachedRoot: string | undefined;

/** Walks up from this module until a `package.json` is found. */
export function getPackageRoot(): string {
    if (cachedRoot) {
        return cachedRoot;
    }

    if (process.env.PROXY_PACKAGE_ROOT && existsSync(process.env.PROXY_PACKAGE_ROOT)) {
        cachedRoot = path.resolve(process.env.PROXY_PACKAGE_ROOT);
        return cachedRoot;
    }

    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 12; depth++) {
        if (existsSync(path.join(dir, "package.json"))) {
            cachedRoot = dir;
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    cachedRoot = process.cwd();
    return cachedRoot;
}

/** Absolute path to the static chat UI directory, or `undefined` when absent. */
export function getStaticUiDir(): string | undefined {
    for (const candidate of [path.join(getPackageRoot(), "public", "chat"), path.join(process.cwd(), "public", "chat")]) {
        if (existsSync(path.join(candidate, "index.html"))) {
            return candidate;
        }
    }
    return undefined;
}

/** Directory holding persisted chat sessions (created lazily by the store). */
export function getChatDataDir(): string {
    const configured = process.env.CHAT_DATA_DIR;
    if (configured) {
        return path.resolve(configured);
    }
    return path.join(getPackageRoot(), "data", "chats");
}
