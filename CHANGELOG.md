# Changelog

Notable changes, newest first. This project is pre-release (`0.0.x`) and built in the open by several AI agents coordinating through the very tool they're building — so the log is candid, including the bugs that shaped the design. A more detailed day-by-day record lives in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## Unreleased

### Desktop-App agents join as first-class targets — 闪电说 (`sds`) via register + pull over HTTP (ADR-024)

Until now every agent anytoany could address had a headless CLI to resume into. A desktop App's built-in assistant has none — so it could send (by borrowing `@user:cli`) but nobody could ever reply to it. Phase 5 adds a generic **external agent** channel; 闪电说 is its first user, and the point is to let it act as a cockpit that drives Claude Code, Codex and the rest.

- **Registration** (`~/.anytoany/registered/`, one file per session, mirroring `monitor.ts`): an App registers itself and becomes addressable — `@sds:…` resolves, `anyd list` shows it (tagged `external, pull-only`), replies have somewhere to go. 7-day TTL; the names `user`/`claude`/`codex`/`kimi`/`zcode` are reserved.
- **Pull-only delivery**: the dispatcher's existing skip (`isMonitored` / `isSessionLive`, ADR-019/023) grows one more arm, `isPullOnly`. Mail for an external agent stays `pending` with `attempts=0` instead of retrying three times against an adapter that does not exist and dead-lettering.
- **HTTP, not the CLI** — and this was the finding that rewrote the design. Reading 闪电说's source (branch `codex/dsh-assistant-ui-v0.8`) turned up three hard constraints: its assistant shell inherits the App's minimal GUI PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) and runs a non-interactive bash with `$SHELL` stripped, so `anyd` is simply unreachable; its `workspace-write` sandbox blocks writes to `~/.anytoany` (but leaves network alone); and it has **no self-drive at all** — no cron, no timers, nothing wakes it until the user speaks. So the App talks to the local daemon with `curl`, which is immune to all three, and works whether or not the user has raised the App's permission level.
- **New endpoints**: `POST /api/inbox` (registers, refreshes and collects in one call, reusing `collectInbox()` so dead-letter recovery from ADR-022 comes along for free), `POST /api/register`, and `q`/`agent`/`limit` filters on `GET /api/sessions` — unfiltered it is 4000+ sessions and ~850KB, fine for the console, unusable inside an agent's turn.
- **OS notification for pull-only mail**: a pending message is never claimed, so it never emits a `delivered` event and the normal notifier never fires. Since the App cannot wake itself either, that notification is the only signal the operator gets that a reply arrived.
- **`anyd connect sds`** installs the integration into the App's own data directory — preview by default, `--apply` to write, `--uninstall` to roll back. It writes a SKILL.md, flips the skill's enable bit (a hand-placed SKILL.md is disabled by default), and appends a marked block to `AGENTS.md`, touching nothing else.
- **Getting other people onto it**: `anyd setup` (which `install.sh` runs) now detects the App and prints the one command; `anyd doctor` reports whether it's connected, and distinguishes "skill file present" from "skill actually enabled". A shareable Chinese walkthrough lives at [docs/guides/shandianshuo.zh-CN.md](docs/guides/shandianshuo.zh-CN.md) — the App has no skill marketplace or import, so the distribution unit is anytoany itself, not the skill (which is only a thin client for the daemon).
- **Honest limitation**: sending is instant, receiving happens on the App's next turn. Push injection was investigated and ruled out — the remote RPC port is random and its token never touches disk; the ACP path has no CLI and would be reaped by the App's own stale-runtime killer.

### Don't headless-resume a *live* Claude session — the false-fail that made "Codex's messages won't get through" (ADR-023)

- **Real incident, watched live.** A Codex session kept delegating to a Claude session (MuselyStudio dev), and every message showed `dead`/`failed` — "Codex's messages simply don't get through." But grepping the target transcript proved the opposite: the dead message id appeared **10×** — the injected turn had physically landed (and been re-injected by the 3 retries). Switching to a second, small (762 KB) Claude session failed the same way, with an *empty* stderr. The common factor wasn't transcript size or a specific hook — **both target sessions were open in an interactive process at the time.**
- **Root cause.** `claude -p --resume <id>` runs the turn and persists it, *then* fires the operator's post-turn hooks; resuming into a session a human already has open makes `claude -p` exit non-zero anyway (a SessionEnd hook choking on a 495 MB transcript → "Hook cancelled"; or simply exit 1 with empty stderr when two processes share the session). anytoany judged delivery purely by exit code, so it false-failed, retried 3× — re-injecting duplicate turns into the session the operator was actively using — then dead-lettered a message that had already arrived. Compounded by Codex #28259 (a live UI doesn't refresh after a headless resume), the cockpit showed "nothing arrived" though it arrived three times.
- **Fix — two layers.** (1) *Primary:* the dispatcher now **skips resume-delivery to a session open in an interactive Claude process** (detected from `ps`: interactive uses `--resume=<uuid>`, our delivery uses `--resume <uuid>`), leaving the message **pending** for the session's own pull hook — the same treatment a monitored session already gets. Strictly better: live sessions were invisible via resume anyway (#28259); now they receive with zero duplicates and no false `dead`. (2) *Fallback:* for a *closed* session, a non-zero exit whose only failure is a post-turn lifecycle hook (Stop/SessionEnd/SubagentStop) with turn output present is treated as **delivered**, not retried. Plus: headless auth failures ("not logged in" / "OAuth … expired") now return a clear, non-retryable hint instead of a cryptic `exited 1`.
- **Proven, not assumed.** TDD across `session-liveness`, `dispatcher`, and `adapter-deliver` (full suite **276** green); dist smoke (exit-code handling 4/4, real-`ps` liveness detection); a real-daemon probe (a pending message to a live session stays pending, 0 attempts, no resume); and live confirmation — post-fix Codex→Claude messages to the open session delivered `attempts=0` via the pull hook (vs the old `attempts=3`, 10× duplicated), even while the CLI's headless OAuth was expired. Daemon restarted so the delivery-path change is live.

### Failed deliveries no longer vanish — the pull hook recovers dead-lettered messages (ADR-022)

- **Real incident.** A Claude Code session (PixJelly) and a Zcode session were collaborating; Zcode replied `DONE b04583b pushed…`, but delivering that reply back via `claude -p --resume` into a *live, 95 MB* Claude session failed (`exited 1`), retried 3×, and dead-lettered — gone. From the operator's side it looked like "Zcode never replied." Across the whole mailbox, **all 8 dead letters were the same `resume exited 1`** — systemic, not a fluke; the target session file was 95 MB and still being written, so the session was open, not gone.
- **Root cause.** Dead-lettering assumed "undeliverable = lost." But Claude/Codex/Kimi all have a reliable pull fallback (the prompt-hook + `anyd pull`), and `collectInbox` only surfaced `pending` messages — never `dead` — so a message the daemon gave up on bypassed the very fallback that could still deliver it.
- **Fix.** `mailbox.inbox` gains `undeliveredOnly` (reads `status='dead'`) and its `take` now marks `dead → delivered`; `collectInbox` (shared by the prompt-hook and `anyd pull`) now also surfaces dead-lettered messages addressed to the session — flagged "this failed to deliver live; here it is, nothing lost" — marked seen, deduped, no repeat. A cross-agent message that fails headless delivery is now **recovered automatically on the recipient's next prompt / pull** instead of lost; the 8 already-stuck messages recover the same way. Same philosophy as ADR-020 Piece 0 (`@user:cli` never dead): undeliverable ≠ lost.
- Honest scope: recipient-side recovery — the daemon still retries 3× before dead-lettering (a few wasted resumes, no data loss). Deeper fixes (don't headless-resume a *live* Claude session; huge sessions failing resume) are tracked separately. Verified TDD red→green, full suite 267 green, and reproduced against the compiled dist.

### Self-driving collaboration loop — the daemon keeps execute-tasks moving on its own (ADR-020)

- **Fixes the failure real use kept hitting.** A worker handed a multi-hour task did one slice ("scaffolded, audited the contract — ETA 2-3h") and then *stalled* — turn-based delivery wakes a session for one ~5-minute headless turn and nothing drives it between messages, so the operator had to chase it and finally take the task over (conversation `62f1741f`; the worker later admitted "I only processed message-sync, didn't continue executing per the ETA"). Now the always-on daemon is the clock: for a task the lead tags `--auto`, it keeps nudging the owner forward until the work is done or genuinely stuck.
- **Judged by product, not promises.** Each tick reads whether the owner logged a *new concrete product* in its progress section (a file, a sha, an `n/m` step). Forward motion → nudge the next chunk. No new product → self-retry a couple of rounds (default 2), then hand to the **lead** to judge — redirect the worker, or summarise and escalate to the operator. A dumb wall-clock ceiling (default 1h) is the failsafe, and destructive/irreversible steps are never auto-run (they go to `needs-decision`). A live-monitored session and cross-device owners are skipped, so the loop never double-drives.
- **The operator is pinged only at the two moments that need them — "done" or "stuck" — through `@user:cli`, now a never-dead sink**: a reply home falls back to the local inbox instead of dead-lettering when relay is unavailable (2 of the 5 historical dead letters were `@user:cli`). Owner-tunable via `autorun` in `~/.anytoany/config.json` (`enabled` / `tickIntervalSec` / `maxRetries` / `maxWallClockSec`); on by default, one flag to turn off. Design in ADR-020 and [docs/specs/phase4-selfdrive-loop.md](docs/specs/phase4-selfdrive-loop.md).

### `anyd monitor` — live, visible, in-session delivery (fixes the Codex invisibility problem)

- A new delivery model borrowed from [agmsg](https://github.com/fujibee/agmsg)'s design: instead of the daemon pushing a message via a headless `resume` (which appends a turn the interactive app doesn't reliably show — Codex #28259), the **live agent session runs a blocking `anyd monitor`** that pulls messages addressed to it and prints them **in its own turn**, so they appear in the app naturally — no manual `pull`/reload, no invisible headless turns. Loop: `anyd monitor` → act → `anyd reply` → `anyd monitor`. While monitoring, a session writes a heartbeat; the dispatcher checks it and **does not resume-deliver to a monitored session** (`claimNextPending` skips it, leaving the message pending for the monitor). Same-machine monitor↔monitor needs no daemon at all. This is what turns agent collaboration from "click, then act" into messages just flowing in. See ADR-019.

### `anyd pull --history` — see the whole recent exchange, not just "what's new"

- Fixes a real hole: once a message is delivered (Codex/Kimi/Z Code handle it in a headless turn) and the "already seen" cursor moves past it, plain `anyd pull` correctly says "nothing new" — but the interactive app never showed that message either, so you couldn't see it at all. Diagnosed live: a Codex session had 17 real cross-agent messages (two of them `dead`/failed) that `pull` would never surface again. `anyd pull --history` is a read-only view of the recent exchange in **full** — both directions, oldest→newest, **including failed/`dead` messages that never reached you** — ignoring the cursor.
- **The `reload` skill now runs `anyd pull --history` and pastes its full output into the visible reply.** Root-caused from a Codex rollout: the skill had been running plain `anyd pull` (→ "nothing new"), and even when `--history` ran and returned the full 14 KB exchange, Codex put that command output in a *collapsed* block and the agent only summarized it (falsely saying "shown above") — so the operator saw nothing. The skill now (a) uses `--history` for "reload / show me what happened", and (b) explicitly instructs the agent to reproduce the output verbatim in its reply, because Codex/Kimi/Z Code hide command output. Grounded in the known Codex desktop bug [openai/codex#28259](https://github.com/openai/codex/issues/28259) (`codex exec resume` appends to the transcript but the UI doesn't refresh).

### Collaboration layer — the shared plan is now born with the connection (ADR-018)

- **Reverses the earlier "create the plan manually, after the fact" model.** Now the moment two agent sessions connect, the first agent↔agent message **auto-creates a seeded shared plan** — lead = the initiator, body seeded with the request itself — so alignment exists from message one and the delivery already carries the SHARED PLAN footer. Real using surfaced that a manual, post-hoc "Create shared plan" button had the order backwards: alignment should be collaboration's *first* step, done by the agents, not a human afterthought.
- The skill now makes **"align first — decompose the request into the plan"** the opening move of any real collaboration (proportional to the work: a one-off ask gets a one-line goal, a real feature gets a full breakdown). The console's manual Create/Edit buttons stay as a **fallback**. It's a hard mechanism (the doc always exists) plus a soft one (the lead fills it in), since writing goals/division needs the agent to think — the daemon only seeds the raw request. See ADR-018 and spec §7.

### Web console — create/edit the shared plan, clearer status, per-recipient compose

- **Create & edit a shared plan from the console.** A conversation with no doc shows a **➕ Shared plan** button (pick who leads + write the plan); once it exists, an **Edit plan** button on the panel lets the operator revise it. New endpoints `POST /api/collab/:id/create` and `POST /api/collab/:id/plan`. No more dropping to the CLI just to start a doc.
- **Live indicator** now shows a coloured dot — green "Live — receiving updates" when the SSE stream is connected, red when reconnecting — instead of an easy-to-miss grey bullet.
- **Compose "as you" now targets one agent.** The old "As you — send to both" option is replaced by **As you → @A** and **As you → @B** (still in your own voice, pinned to the thread), since broadcasting the same message to both sides wasn't useful.

### `anyd pull` — manual reload for interactive apps

- New `anyd pull` command + a `reload` skill (say "/reload"). Interactive agent apps (Codex, Kimi, Z Code) cache the session in memory and don't live-refresh from disk, so a cross-agent message delivered as a headless turn can sit unseen until you restart. `anyd pull` reads the mailbox on disk for the current session (auto-detected by working directory, or `--session`/`--cwd`), injecting anything pending and showing an FYI digest of already-handled traffic — the manual counterpart to Claude Code's automatic inbox hook, which is why only non-Claude apps needed it. Works with the daemon down. The delivered-message injection also got the ADR-016 trusted-teammate framing (was still the stale "external data" wording). The `reload` skill is installed alongside `any-to-any` by `anyd setup`.

### Collaboration layer (Phase 4) — M4: semi-automatic progression

- The console now has a **▶ Continue** button on every open task. One click nudges that task's owner to do the next chunk — it resolves the owner label to a live session and sends an in-thread message ("continue task X, read the shared plan, do the next chunk, log progress"), pinned to the collab conversation so the delivery carries the shared-plan footer. It is operator-triggered by design, so it cannot self-loop. Endpoint `POST /api/collab/:id/advance`. A fully-automatic scheduler (wake the worker for the next chunk without a click) is deliberately deferred until "when to stop" is settled.

### Collaboration layer (Phase 4) — M3: cross-device doc sync

- A collaboration doc now **syncs across paired devices**, keyed by the same `conversationId` on both. Sync is an explicit push (`anyd collab sync <id> --to @<device>`) — like `git push` — and the merge is **convergent**: the lead-owned region (plan + tasks) is last-writer-wins, and each agent's append-only progress section is unioned by taking the fuller copy, with deterministic tie-breaks so both machines reach byte-identical state after exchanging docs. New `src/collab/merge.ts`, a token-gated `POST /api/peer/collab` receive endpoint, `pushCollabDoc` transport, and `store.merge()`. Proven by two daemons converging over real HTTP in the test suite; a two-Mac verify script is in `scripts/verify-m3-crossdevice.sh`.
- Deferred to M3.1 (needs a cross-machine conversation id): fully automatic sync-on-message and the receiving side's console/​envelope association. Today the receiving side sees the synced doc via `anyd collab show/list`.

### Collaboration layer (Phase 4) — M2: the shared doc in the web console

- The web console now renders a conversation's **shared plan** inline: a collapsible panel with colour-coded task badges (assigned / working `n/m` / blocked / needs-decision / done / failed), the lead's plan, and each agent's progress. Conversations that have a doc get a 📋 marker in the list. New read-only endpoints `GET /api/collab` and `GET /api/collab/:id`; the change-poller now also watches doc timestamps, so a progress line appended from the CLI shows up in the console within a poll cycle — no manual refresh. Verified in-browser end-to-end.

### Collaboration layer (Phase 4) — M1: same-machine shared doc

- **Shared collaboration document** per conversation at `~/.anytoany/collab/<conversationId>.md`. The doc is the durable coordination state (plan + task list + everyone's progress); messages become lightweight events that point into it. One **lead** owns the plan and task list (single-writer, enforced — a non-lead edit is refused); every agent appends only to its **own** `## Progress — <agent>` section, so there are no write conflicts.
- On-disk format: a JSON block inside the `---` front-matter fence (a strict YAML subset — human- and machine-readable, zero new deps, round-trip safe) + lead-owned markdown body + per-agent progress sections. Writes go through an `O_EXCL` file lock + atomic temp-and-rename.
- New CLI: `anyd collab init | show | list | plan | task | progress | lead`. When a conversation has a doc, the delivery envelope gains a `--- SHARED PLAN ---` footer pointing the recipient at it (a pointer, not the whole doc inlined — keeps token cost down) with its exact label and ready-to-run commands. The skill teaches the turn-based protocol (one chunk per turn, progress by product not time, lead-owns-plan).
- Scope: creation is explicit via `collab init` (auto-create-on-first-message is deferred to M2); cross-device sync is M3. 48 new tests; verified end-to-end via the real CLI. Design: [docs/specs/phase4-collab-doc.md](docs/specs/phase4-collab-doc.md), ADR-017.


Everything below has shipped to `main`. No tagged release yet.

### Agents (5)

- **Claude Code**, **Codex**, **Kimi Code**, and **ZCode** (Z.ai / Zhipu) — discovery + delivery, verified end-to-end. **Gemini CLI** discovery is next.
- Delivery rides each vendor's own headless resume channel (`claude -p --resume`, `codex exec resume`, `kimi -S … -p`, ZCode's bundled engine) — argv-only, no shell interpolation, no `--dangerously-*`.
- Each adapter was reverse-engineered and verified against the real CLI; the notes (and every "the docs say X but the binary does Y" correction) live in `docs/research/`.

### Cross-device (LAN)

- Devices pair with a shared token, discover each other via mDNS/Bonjour, and relay over direct LAN HTTP — no cloud, no accounts. `anyd pair --invite` prints a single copy-paste installer + token.
- Hardened after real first-connect debugging: separate publish/browse mDNS instances, RFC1918 address selection (ignores proxy-TUN fakes), stable device identity, periodic re-query, host:port de-duplication.

### Messaging model

- Durable SQLite mailbox with an ack / retry / dead-letter state machine, loop-depth and rate caps, and crash recovery of in-flight messages.
- Envelope protocol with a mandatory verdict (`DONE` / `BLOCKED` / `DECLINED` / `NOOP`) and an anti-hallucination clause (claim only what you observed this turn). Anti-pingpong suppression stops two waiting agents ack-looping.
- **Trusted-teammate trust model (ADR-016):** inside your own single-operator, shared-token, LAN-only cluster, a relayed request carries your authority — agents collaborate instead of refusing legitimate work as "untrusted." Agents keep full autonomy and honesty; owner-controlled, per-machine escalation is opt-in and off by default.
- Three-party context (ADR-014): messages you send "as yourself" to both agents stay in one thread instead of splitting it.

### Web console

- A single-file, zero-dependency IM-style console at `127.0.0.1:7433` (loopback-only): one-column timeline with avatars, names, timestamps, live delivery states, retries, and a search-driven "new conversation" flow. 26 agent brand icons embedded, no external requests.

### Distribution & ops

- One-command `install.sh`; agent-native install (paste the repo URL to any agent). Built `dist/` is committed so `npm i -g git+https://…` is a **zero-compile** install.
- Persistent daemon via a launchd LaunchAgent (`scripts/install-daemon-launchd.sh`) with `KeepAlive` — survives logout/sleep and auto-restarts.
- CI runs Ubuntu-only per push (macOS on a weekly/manual schedule) after a runaway-minutes incident; `concurrency: cancel-in-progress` and doc-only path filters keep it cheap.

### Notable fixes along the way

- `codex --sandbox` must precede the `resume` subcommand, or every reply silently fails.
- Cross-device replies addressed to the human must relay home, not get captured as a local inbox.
- A test that wrote to the real `~/.anytoany/` was deleting the live daemon's pid file on every run.
- A heavy delivered turn that outran the 5-minute budget was killed and blindly retried, re-running (and duplicating) the same long work. Per-turn budget is now owner-configurable (`codex.deliverTimeoutSec` / `zcode.deliverTimeoutSec`, 60–3600s), and a timeout now fails terminally instead of looping.

---

The detailed, dated history (including lessons and course-corrections) is in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md); architecture and decisions are in [`docs/`](docs/).
