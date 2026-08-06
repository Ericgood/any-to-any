import { homedir } from 'node:os';
/** '2m ago', '3h ago', '5d ago' — coarse relative time for directory listings. */
export function formatRelativeTime(epochMs, nowMs = Date.now()) {
    const diff = Math.max(0, nowMs - epochMs);
    const min = Math.floor(diff / 60_000);
    if (min < 1)
        return 'just now';
    if (min < 60)
        return `${min}m ago`;
    const hours = Math.floor(min / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
/** Abbreviate the user's home directory to '~' for display. */
export function shortenHome(path, home = homedir()) {
    return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
//# sourceMappingURL=format.js.map