---
name: reload
description: Show the recent cross-agent (anytoany) exchange in THIS session — what other agent sessions sent and replied — without restarting the app. Use when the user types /reload, $reload, says "reload", "刷新", "拉一下消息", "看看发生了啥", "有没有漏的", or otherwise wants to see cross-agent activity they can't see in this app. Needed in Codex / Kimi / Z Code, whose interactive UI does not reliably show messages delivered in headless turns (a known Codex bug, openai/codex#28259).
---

# reload — show the cross-agent exchange in this session

Codex / Kimi / Z Code deliver cross-agent messages in **headless turns** and do NOT reliably refresh the interactive UI to show them (known Codex bug: [openai/codex#28259](https://github.com/openai/codex/issues/28259)). The messages are safely on disk — your job is to surface them into the visible conversation.

## When the operator wants to SEE what happened

Triggers: `/reload`, `$reload`, "reload", "刷新", "拉一下消息", "看看发生了啥", "有没有漏的", or plain `anyd pull` reported nothing new but they clearly want to review.

1. Run:

```bash
anyd pull --history
```

This prints the recent cross-agent exchange in **full** — both directions, oldest→newest, including failed/`dead` messages — read-only, ignoring any "already seen" cursor. (Add `--limit N` for more/fewer.)

2. **CRITICAL — paste that output into your visible reply.** Codex / Kimi / Z Code put command output in a **collapsed block the operator does not see**. If you only summarize — or say "shown above" — the operator sees **nothing**, and it looks like reload did nothing. This is the single most common failure. So:
   - **Reproduce the command's full output verbatim in your reply, inside a fenced code block.** Then add at most a one-line note (e.g. which messages are `dead`/undelivered).
   - Do NOT re-reply to or re-run those messages — they were already handled. This is a read-only recap so the operator can read the exchange.

## Checking for NEW messages you must still ACT on

Different job: to catch messages not yet handled (so you can do the work), run `anyd pull` (plain). Pending messages are injected in full — act on each per the any-to-any protocol (`anyd reply <id> …` or the `<<<ANYTOANY_REPLY>>> DONE/BLOCKED` verdict). An "Activity digest" is FYI only — do not re-run it.

Run `anyd pull --quiet` **proactively** (silent when nothing new) at the start of a collaboration turn, right after messaging a peer, or when the operator asks about another agent.

## Notes

- Works with the `anyd` daemon down — it reads the mailbox on disk. That's the point: it's a disk pull, minus the restart.
- Auto-detects your session by the current directory. If it can't (you changed dirs, or several sessions share the dir), pass it: `anyd pull --history --session "@<agent>:<fragment>"` (find yourself in `anyd list`).
