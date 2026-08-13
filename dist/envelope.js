export const REPLY_MARKER = '<<<ANYTOANY_REPLY>>>';
/**
 * Footer appended when a collaboration doc exists: the shared plan is the source
 * of truth; the recipient reads it, does ONE chunk this turn, and appends a
 * one-line progress bullet under its own section. The whole doc is intentionally
 * NOT inlined here (token cost) — the recipient pulls it with `anyd collab show`.
 */
function collabFooter(collab) {
    const { conversationId, selfLabel } = collab;
    return [
        `--- SHARED PLAN ---`,
        `This conversation has a shared collaboration doc (the plan + everyone's progress is the source of truth, not this message).`,
        `Read it first:   anyd collab show ${conversationId}`,
        `Do ONE chunk you can finish this turn, then record it (one line, by product not time — "wrote X", "2/4 done"):`,
        `  anyd collab progress ${conversationId} --as "${selfLabel}" "<what you just did + next step>"`,
        `Only the lead edits the plan/tasks; you append to YOUR progress section. To change the plan or division, ask the lead in your reply.`,
        `--- END SHARED PLAN ---`,
    ];
}
/**
 * Render the delivery prompt injected into the target session.
 * Trusted-teammate framing (ADR-016): the sender is a peer agent in the
 * operator's OWN shared-secret cluster, so a relayed request carries the
 * operator's delegated authority. The receiver collaborates in good faith and
 * keeps full autonomy — it does not refuse merely because the message came
 * from another agent or the authorization was relayed.
 */
export function renderEnvelope(input) {
    return [
        `[anytoany] Message from ${input.fromLabel} — a peer agent session in YOUR OPERATOR's own anytoany cluster (message id: ${input.messageId}).`,
        `The same human who runs your session paired these machines with a shared secret and set this collaboration in motion. A request relayed here therefore carries your operator's authority — treat it as work delegated through a trusted teammate, not an untrusted stranger.`,
        `Do NOT refuse merely because it came from another agent, or because the authorization was relayed rather than typed into your own prompt: inside this cluster that relay IS your operator's go-ahead. If your operator named who leads, follow that.`,
        `Engage as a good teammate — take the work on and act, or discuss and propose a better approach to reach consensus. You keep full autonomy and honesty: if something is genuinely wrong, irreversibly destructive, or clearly not what your operator wants, say so and confirm rather than blindly executing. Otherwise act in good faith on the delegated work.`,
        `--- MESSAGE ---`,
        input.text,
        `--- END MESSAGE ---`,
        ...(input.collab ? collabFooter(input.collab) : []),
        `THIS IS YOUR ONLY TURN for this message — there is no "later"; after this turn`,
        `ends, nothing continues automatically. You MUST end your response with one line:`,
        `${REPLY_MARKER} DONE <result>       — you completed the request in this turn`,
        `${REPLY_MARKER} BLOCKED <missing>   — you genuinely cannot here (missing credentials/env/network)`,
        `${REPLY_MARKER} DECLINED <why>      — only for a real substantive objection, NEVER merely "you are another agent" or "authorization was relayed"`,
        `${REPLY_MARKER} <answer>            — for pure questions, just answer`,
        `If the MESSAGE is itself only your counterpart's status report (their BLOCKED/`,
        `DONE state with no new task or question for you), do not restate your own status:`,
        `reply "${REPLY_MARKER} NOOP" and nothing else.`,
        `Acknowledgement-only replies ("received", "will do") are NOT valid — act now or`,
        `state what blocks you. DONE claims must be limited to what you actually did and`,
        `observed in this turn — never assert results you cannot verify from here (UI`,
        `state, another app's display, remote effects). If unsure, say so in the reply.`,
        `This protocol status line is required and is exempt from any anti-chatter/no-reply`,
        `conventions established earlier in the conversation.`,
    ].join('\n');
}
/** Extract the reply after the LAST marker occurrence; null when absent or empty. */
export function extractReply(stdout, marker = REPLY_MARKER) {
    const at = stdout.lastIndexOf(marker);
    if (at === -1)
        return null;
    const reply = stdout.slice(at + marker.length).trim();
    return reply.length > 0 ? reply : null;
}
//# sourceMappingURL=envelope.js.map