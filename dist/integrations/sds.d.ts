/**
 * 闪电说 (Shandianshuo) desktop integration — the first external agent (ADR-024).
 *
 * Its assistant runs on the DeepSeek-Harness SDK runtime inside a Tauri app.
 * Three source-verified constraints shape everything here:
 *
 *   1. The assistant shell inherits the App's minimal GUI PATH
 *      (/usr/bin:/bin:/usr/sbin:/sbin) and runs a non-interactive bash with
 *      $SHELL stripped — so `anyd` is not reachable and .zshrc is not read.
 *   2. Its sandbox is `workspace-write`: file writes outside the workspace need
 *      an approval prompt, but reads, network and process visibility are free.
 *      So we talk HTTP to the local daemon instead of writing ~/.anytoany.
 *   3. A user-dropped SKILL.md is DISABLED by default — the skill only loads if
 *      its key is set in skills-state.json.
 *
 * We write into the App's own data directory, so every change here is surgical:
 * the user's other skills, toggles and AGENTS.md content are never touched.
 */
export interface SdsPaths {
    appHome: string;
    workspace: string;
    skillDir: string;
    skillFile: string;
    stateFile: string;
    agentsFile: string;
}
export interface SdsChange {
    path: string;
    action: 'create' | 'update' | 'unchanged' | 'delete';
    /** Full file content to write; absent for a delete. */
    content?: string;
    /** One line explaining the change, for the dry-run printout. */
    note: string;
}
/** `~/Library/Application Support/Shandianshuo` (identifier cn.shandianshuo.desktop). */
export declare function defaultAppHome(home?: string): string;
export declare function resolveSdsPaths(opts?: {
    appHome?: string;
    home?: string;
}): SdsPaths;
/** Insert or replace our fenced block, leaving everything else byte-identical. */
export declare function upsertMarkedBlock(existing: string, body: string): string;
/** Remove our fenced block; a document without one is returned unchanged. */
export declare function removeMarkedBlock(existing: string): string;
export declare function sdsSkillMarkdown(port?: number): string;
/** Compute the three writes without touching disk. */
export declare function planSdsInstall(paths: SdsPaths, opts?: {
    port?: number;
    now?: () => number;
}): SdsChange[];
/** Compute the removal of exactly what we installed. */
export declare function planSdsUninstall(paths: SdsPaths): SdsChange[];
/** Perform a plan. `unchanged` entries are skipped, so this is safe to re-run. */
export declare function applyChanges(changes: SdsChange[]): void;
