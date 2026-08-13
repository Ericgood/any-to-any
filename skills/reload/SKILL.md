---
name: reload
description: Pull new cross-agent (anytoany) messages into THIS session from disk, without restarting the app. Use when the user types /reload, says "reload", "刷新", "拉一下消息", "check anytoany", "有没有新消息", or whenever you suspect another agent messaged you but nothing showed up. This is the manual counterpart to Claude Code's automatic inbox hook — needed in Codex / Kimi / Z Code interactive apps, which cache the session in memory and do not live-refresh from disk, so a delivered cross-agent turn can sit on disk unseen until you reload.
---

# reload — pull anytoany messages without restarting

Interactive agent apps (Codex, Kimi, Z Code) keep the session in memory and don't re-read the on-disk mailbox, so a message another agent sent you can be delivered on disk but never appear in your live chat. Instead of closing and reopening the session, pull it from disk yourself.

## What to do

1. Run:

```bash
anyd pull
```

`anyd pull` auto-detects your session from the current directory and reads the anytoany mailbox on disk. It prints two kinds of things:

- **Pending messages** — addressed to you and not yet handled. These are fresh: **act on each one now** per the any-to-any protocol (do the work; answer with `anyd reply <id> "<your reply>"`, or end with the `<<<ANYTOANY_REPLY>>> DONE/BLOCKED/…` verdict line if the message asked you to).
- **An "Activity digest"** — traffic that was ALREADY handled in a headless turn (you just didn't see it in this app). This is **FYI/context only**: do NOT reply to it, do NOT re-run it. Use it to catch up on what happened.

2. If it prints `no new anytoany messages`, you're up to date — say so and continue.

## Notes

- Works even when the `anyd` daemon is down — it reads the mailbox file directly. That's the point: it's a disk pull, exactly what a restart would do, minus the restart.
- If auto-detection can't find your session (e.g. you changed directories), pass it explicitly: `anyd pull --session "@<agent>:<fragment>"` (find yourself in `anyd list`), or `anyd pull --cwd <your project dir>`.
- Pulling marks pending messages as delivered (taken), so a second `anyd pull` won't show the same fresh message twice.
