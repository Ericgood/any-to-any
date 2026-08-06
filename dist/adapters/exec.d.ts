import type { ExecFn } from './types.js';
/**
 * Default ExecFn: argv-style spawn (no shell — message text can never be
 * interpreted by a shell), stdin closed (agent CLIs must not wait for piped
 * input), resolving with exit code instead of rejecting.
 */
export declare const realExec: ExecFn;
