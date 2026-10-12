import type { ExecFn } from './types.js';
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
export declare const VERSION_MISMATCH = "version_mismatch";
/** Numeric `major.minor.patch` core of any version-bearing string; prerelease is ignored. */
export declare function parseVersion(raw: string): [number, number, number] | null;
/**
 * True only when the CLI is strictly older than the session's writer. A newer CLI
 * (the common case after an auto-update) resumes older sessions fine, and an
 * unparseable side never blocks — the delivery's own error handling takes over.
 */
export declare function isCliOlder(cliVersion: string, writerVersion: string): boolean;
/** One observation: `originator` (e.g. 'Codex Desktop') was running `version` at `at` (epoch ms). */
export interface WriterSample {
    originator: string;
    version: string;
    at: number;
}
/**
 * Who most plausibly wrote a session last. Codex records `cli_version` only once,
 * when the thread is created — a months-old Desktop thread still says 0.144.2 while
 * today's Desktop (0.162.0-alpha) writes it daily. So take the highest version the
 * same originator was seen running at or before the session's last activity, never
 * lower than the session's own record. Unknown originator → the own record as-is.
 */
export declare function inferWriterVersion(own: string | undefined, originator: string | undefined, lastActiveAt: number, samples: readonly WriterSample[]): string | undefined;
export type VersionProbe = () => Promise<string | null>;
/**
 * `<cmd> --version`, cached for `ttlMs` so a hot dispatch loop doesn't spawn on
 * every message, yet an operator's upgrade takes effect within a minute — no
 * daemon restart needed. A missing/failing CLI yields null (= don't block).
 */
export declare function createVersionProbe(exec: ExecFn, cmd: string, opts?: {
    ttlMs?: number;
    now?: () => number;
}): VersionProbe;
export interface VersionGuardSpec {
    /** CLI binary anytoany delivers with, e.g. 'codex'. */
    cli: string;
    /** What usually writes these sessions, for the human-facing message. */
    app: string;
    /** Exact command the operator should run. */
    upgrade: string;
}
/** null = OK to deliver; otherwise a `version_mismatch: …` error for the sender. */
export declare function checkCliVersion(probe: VersionProbe, spec: VersionGuardSpec, writerVersion: string | undefined): Promise<string | null>;
