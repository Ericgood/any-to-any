/**
 * "Which session am I?" for commands that act on the caller's own mailbox
 * (`anyd pull`, `anyd monitor`) when no --session is given.
 *
 * Matching by working directory alone is NOT an identity: Claude and Codex
 * routinely share a project folder. On 2026-10-24 a Codex thread sent a hand-off
 * to the Claude session in the same folder, then ran `anyd pull --quiet` — which
 * took the Claude session's new mail as its own. So the agent's own session id
 * (exported to its shell) comes first; a folder only identifies you when exactly
 * one session lives there; otherwise refuse rather than guess.
 */
/** Session-id variables the agents export to the commands they run. */
const SELF_ENV = [
    { variable: 'CLAUDE_CODE_SESSION_ID', agent: 'claude' },
    { variable: 'CODEX_THREAD_ID', agent: 'codex' },
];
const labelOf = (s) => `@${s.agent}:${s.title}`;
export function resolveSelfSessions(sessions, cwd, env = process.env) {
    for (const { variable, agent } of SELF_ENV) {
        const id = env[variable];
        if (!id)
            continue;
        const known = sessions.find((s) => s.agent === agent && s.sessionId === id);
        return { ok: true, targets: [{ id, label: known ? labelOf(known) : `@${agent}:${id}` }] };
    }
    const here = sessions.filter((s) => !s.device && s.cwd === cwd);
    if (here.length === 1)
        return { ok: true, targets: here.map((s) => ({ id: s.sessionId, label: labelOf(s) })) };
    return { ok: false, reason: here.length === 0 ? 'none' : 'ambiguous', candidates: here };
}
/** Human-readable refusal for the CLI. */
export function describeSelfFailure(r, cwd) {
    if (r.reason === 'none') {
        return `no session found for ${cwd} — open a session here, or pass --session "@<agent>:<fragment>"`;
    }
    return [
        `${r.candidates.length} sessions share ${cwd}, so this command can't tell which one is you — and taking`,
        `another session's mail would hide it from that session. Pass --session explicitly:`,
        ...r.candidates.map((s) => `  --session "@${s.agent}:${s.sessionId.slice(0, 8)}"   # ${s.title}`),
    ].join('\n');
}
//# sourceMappingURL=self.js.map