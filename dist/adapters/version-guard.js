/**
 * Pre-send CLI version guard (ADR-025).
 *
 * Headless delivery resumes a session with the GLOBAL CLI (`claude -p --resume`,
 * `codex exec resume`), but the session itself is usually written by the desktop
 * App, which bundles its own — often newer — CLI. An older CLI resuming a session
 * a newer one wrote fails, frequently as a bare "exit 1" with an empty stderr
 * (verified 2026-10-12: CLI 2.1.287 vs App 2.1.295 dead-lettered d00591bc 3×).
 * The ADR-022 pull hook then quietly recovered the message, hiding the cause.
 * So: compare before sending, and fail loudly with the upgrade command.
 */
/** Stable prefix: the server, notifier and prompt hook key off it. */
export const VERSION_MISMATCH = 'version_mismatch';
const CORE_RE = /(\d+)\.(\d+)\.(\d+)/;
const DEFAULT_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
/** Numeric `major.minor.patch` core of any version-bearing string; prerelease is ignored. */
export function parseVersion(raw) {
    const m = CORE_RE.exec(raw);
    if (!m)
        return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}
/**
 * True only when the CLI is strictly older than the session's writer. A newer CLI
 * (the common case after an auto-update) resumes older sessions fine, and an
 * unparseable side never blocks — the delivery's own error handling takes over.
 */
export function isCliOlder(cliVersion, writerVersion) {
    const cli = parseVersion(cliVersion);
    const writer = parseVersion(writerVersion);
    return cli !== null && writer !== null && compareCores(cli, writer) < 0;
}
function compareCores(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return 0;
}
/**
 * Who most plausibly wrote a session last. Codex records `cli_version` only once,
 * when the thread is created — a months-old Desktop thread still says 0.144.2 while
 * today's Desktop (0.162.0-alpha) writes it daily. So take the highest version the
 * same originator was seen running at or before the session's last activity, never
 * lower than the session's own record. Unknown originator → the own record as-is.
 */
export function inferWriterVersion(own, originator, lastActiveAt, samples) {
    if (!originator)
        return own;
    let best = own;
    let bestCore = own ? parseVersion(own) : null;
    for (const s of samples) {
        if (s.originator !== originator || s.at > lastActiveAt)
            continue;
        const core = parseVersion(s.version);
        if (core && (!bestCore || compareCores(core, bestCore) > 0)) {
            best = s.version;
            bestCore = core;
        }
    }
    return best;
}
/**
 * `<cmd> --version`, cached for `ttlMs` so a hot dispatch loop doesn't spawn on
 * every message, yet an operator's upgrade takes effect within a minute — no
 * daemon restart needed. A missing/failing CLI yields null (= don't block).
 */
export function createVersionProbe(exec, cmd, opts = {}) {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const now = opts.now ?? Date.now;
    let cached = null;
    return async () => {
        if (cached && now() - cached.at <= ttlMs)
            return cached.value;
        let value = null;
        try {
            const { stdout, code } = await exec(cmd, ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
            value = code === 0 && stdout.trim() ? stdout.trim() : null;
        }
        catch {
            value = null;
        }
        cached = { at: now(), value };
        return value;
    };
}
/** null = OK to deliver; otherwise a `version_mismatch: …` error for the sender. */
export async function checkCliVersion(probe, spec, writerVersion) {
    if (!writerVersion)
        return null;
    const cliVersion = await probe();
    if (!cliVersion || !isCliOlder(cliVersion, writerVersion))
        return null;
    return (`${VERSION_MISMATCH}: the ${spec.cli} CLI anytoany delivers with (${cliVersion}) is older than the ` +
        `${spec.app} that last wrote this session (${writerVersion}). Resuming it with the older CLI fails ` +
        `(often a bare "exit 1"), so the message was NOT sent. Ask the operator to upgrade: ${spec.upgrade} ` +
        `— then resend (a dead-lettered one can be retried from the console, 127.0.0.1:7433). See ADR-025.`);
}
//# sourceMappingURL=version-guard.js.map