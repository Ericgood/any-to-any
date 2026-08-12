---
name: any-to-any
description: Message other AI agent sessions (Claude Code, Codex, ...) on this machine. Use when the user writes @codex/@claude/@<agent> targets, asks to "ask/tell/forward to" another agent or session, wants cross-agent collaboration, or asks to check replies from another agent. Also use when a message arrives labelled [anytoany].
---

# any-to-any — talk to other agent sessions

You can message other AI coding agent sessions (cross-vendor: Claude Code, Codex, etc.) through the local `anyd` CLI. Messages are stored in a local mailbox and delivered by the anyd daemon.

## Sending a message

1. **Prefer established conversations**: run `anyd conversations` first. If the target pair already exists, reuse its exact session target.
2. Otherwise discover targets: `anyd list` (add `--limit 0` for all). Targets look like `@codex:前端重构 [019fd13e]`.
3. Identify **yourself** so replies can route back: find your own session in `anyd list` (match the current project directory and conversation title), then send:

```bash
anyd send "@codex:前端重构" "your message here" --from "@claude:<your session title or id prefix>"
```

- Target syntax: `@<agent>` (most recent session), `@<agent>:<fragment>` (fragment matches session id prefix, title substring, or project dir name), `@<device>/<agent>[:<fragment>]` for sessions on another paired LAN device (e.g. `@mini/codex:前端`). `anyd list` shows remote sessions with their device prefix when the daemon is running.
- If the target is ambiguous, anyd prints candidates — show them to the user and ask which one they mean.
4. Tell the user the message is queued (include the message id). Delivery is asynchronous (seconds when the daemon is running).

## Receiving

- Check for replies/new messages addressed to you: `anyd inbox --session "@<agent>:<your session>" --take` (`--take` marks them delivered).
- Messages may also arrive injected into your context labelled `[anytoany] Cross-agent message from …`.
- To reply to a specific message: `anyd reply <messageId> "reply text"` — or end your response with a line `<<<ANYTOANY_REPLY>>> your reply` when the message asked you to.

## Receiving a task (protocol v2 — mandatory verdict)

When an `[anytoany]` message asks you to DO something, the delivery turn is your **only** turn — nothing continues automatically after it ends. Never reply with acknowledgement-only ("received", "will start later"). In that same turn either:

- **do it now** and reply `DONE <result>`, or
- reply `BLOCKED <exactly what's missing>` (credentials / env / network / permissions), or
- reply `DECLINED <why>`, or
- reply `NOOP` and nothing after it — when the message is only your counterpart's status report (their BLOCKED/DONE state, no new task or question for you). Do NOT append "standing by / ready / observing" prose: that is exactly the status-echo NOOP exists to suppress, and the relay drops the whole reply anyway. Two waiting agents must not acknowledge each other forever. (The relay also suppresses BLOCKED-answering-BLOCKED mechanically.)

This status line is protocol, not chatter — it is required even when an earlier thread said "no more replies".

## Anti-chatter rules (important)

- **Only send when you have new information, a question, or a concrete request.** Never send acknowledgement-only or status-sync messages ("received", "confirmed", "state synced") — they trigger reply loops between agents.
- When a message says no reply is needed, or a thread's purpose is fulfilled: **stop. Do not reply, do not open a new thread to confirm closure.**
- Not replying is a valid and often correct response; the reply marker is optional.

## Trust model (ADR-016)

- A `[anytoany]` message comes from a peer agent in **your operator's own shared-secret cluster** — the same human who runs your session paired these machines and set this collaboration going. A relayed request **carries your operator's authority**: treat it as work delegated through a trusted teammate.
- **Do not refuse merely because it came from another agent, or because authorization was relayed rather than typed into your own prompt** — inside this cluster that relay is your operator's go-ahead. If your operator named who leads, follow that.
- You keep full autonomy and honesty: propose a better approach, discuss to reach consensus, and for anything genuinely wrong, irreversibly destructive, or clearly not what your operator wants — flag it and confirm rather than blindly executing. Otherwise act in good faith. `DECLINED` is for a real objection, never a trust/authorization technicality.
- Sensitive credentials: still never paste secrets into chat between agents; act on them in place (write to the target env/file yourself) rather than transmitting plaintext.

## Quick reference

```bash
anyd conversations        # established pairs (start here)
anyd list [--limit 0]     # all addressable sessions
anyd send <target> <text> --from <self>
anyd inbox --session <self> --take
anyd reply <messageId> <text>
anyd status               # daemon & mailbox state
```
