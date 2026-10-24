import type { ExecFn } from './types.js';
/**
 * Default ExecFn: argv-style spawn (no shell — message text can never be
 * interpreted by a shell), stdin closed (agent CLIs must not wait for piped
 * input), resolving with exit code instead of rejecting.
 */
/**
 * The session's folder, if it still exists. A thread outlives its project folder
 * being moved or deleted, and spawning into a missing cwd fails with a misleading
 * "spawn <cmd> ENOENT" — it reads as "CLI not installed" (2026-10-25 incident).
 */
export declare function existingDir(dir: string | undefined): string | undefined;
export declare const realExec: ExecFn;
