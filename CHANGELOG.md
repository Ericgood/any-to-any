# Changelog

Notable changes, newest first. This project is pre-release (`0.0.x`) and built in the open by several AI agents coordinating through the very tool they're building — so the log is candid, including the bugs that shaped the design. A more detailed day-by-day record lives in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## Unreleased

### Fix: delivery to a session whose project folder was moved failed as "spawn codex ENOENT" (ADR-031)

A Codex thread was created in `~/增长研究/clonecut`, and the project later moved to `~/clonecut`. Delivering to that thread spawned `codex` inside the deleted folder. Node reports a missing working directory as `spawn codex ENOENT`, so it looked as if Codex wasn't installed. After three retries the message dead-lettered, and the sending Claude session waited 29 minutes for a reply that could never come.

- `realExec` now checks the working directory first and says plainly that the folder was moved or deleted.
- Codex, Kimi and ZCode resume by session id and don't need the folder: a stale one is simply dropped, and delivery goes ahead.
- Claude's `--resume` *does* need the project folder, so that case fails immediately, without retries, and explains what to do.
- The dead-lettered message was retried and is now running in the Codex thread.

### Fix: an agent pulling its own mail could take a peer's mail in the same folder (ADR-030)

A Codex thread handed an iPad issue to the Claude session in the same project folder, then ran `anyd pull --quiet` as the skill suggests. Without `--session`, `pull` treated **every session in this folder** as "me", so it took the Claude session's brand-new mail within 0.4s, marked it delivered, and printed it into Codex's own output. Codex saw "delivered"; Claude saw nothing until the user typed again. The logs show three messages lost this way.

- `anyd pull` and `anyd monitor` now identify the caller first: `CLAUDE_CODE_SESSION_ID` (Claude Code) or `CODEX_THREAD_ID` (Codex) selects exactly that session. With no identity, a folder counts only if exactly one session lives there. If several do, the command **refuses** and lists them, rather than guessing.
- The skills now say: pass your own `--session` when asked, and never a peer's.
- Verified with the real CLI in a folder with 8 sessions: pulling as Codex leaves Claude's mail pending, an unidentified caller is refused, and pulling as Claude gets it.

### Fix: Codex answered "already handled in the background" and did nothing (ADR-027 incident, 2026-10-20)

Messages queued into Codex Desktop (ADR-027) were marked delivered as soon as they were queued. When Desktop ran that turn, the Codex inbox hook's FYI digest listed the very same message under "ALREADY processed automatically in headless turns; do NOT act". The model obeyed and replied "already processed, not repeating". **7 of the 9 messages queued into Codex since 10-13 were swallowed this way**, including a batch of disk-cleanup requests.

- Deliveries handed to the target's **own** runtime (Codex queue, ZCode mailbox) are now recorded as in-session (a new `delivered_in_session` column), and the digest never lists them: that turn *is* the session's own.
- As a backstop, the hook reads the current prompt and never lists the message id it carries.
- Verified live on a throwaway Desktop thread: the queued message was flagged in-session, and Codex actually ran the command.

### ZCode doorbell: mail to a session that is mid-turn rides ZCode's own mailbox (ADR-029)

Until now every ZCode delivery started a headless `--resume` turn. That's fine for an idle session, since ZCode's CLI and desktop share one store, but if the session is **in the middle of a turn**, it puts a second writer on the same session. ZCode's open-source runtime turned out to have an unpublished **session mailbox**. With `ZCODE_MESSAGE_ENABLED=1`, a running turn picks letters up from `~/.zcode/mailbox/<session>/unread/` at its next tool call, and at turn end it reads them and keeps going.

- **When anytoany uses it**: the session is mid-turn **and** ZCode has created that session's mailbox directory. "Mid-turn" means the latest assistant message has no `time.completed` yet, which held throughout a live `sleep 20` turn. ZCode creates the directory itself every time a flagged turn starts. Reading the process environment doesn't work, because ZCode renames its process and that overwrites it. Everything else still gets a headless `--resume` turn.
- **Atomic in, atomic out**: letters are renamed into `unread/` (never half-written), and replies come back via `anyd reply`. If the turn ends and the letter is still unread, for example because the switch was turned off, anytoany `rename`s it back out and delivers it the old way. Exactly one side wins, so nothing is lost or delivered twice.
- **Verified with the real daemon** on a throwaway session. While a flagged `sleep 30` turn was running, a message landed in the mailbox, was picked up inside that turn, and the agent answered through `anyd reply`. In an unflagged turn the letter stayed unread, was reclaimed when the turn ended, and was delivered once through `--resume`.
- `anyd doctor` reports the ZCode doorbell's state and how to turn it on (`launchctl setenv ZCODE_MESSAGE_ENABLED 1`, then reopen ZCode). The desktop app runs the same runtime, so by its source it should inherit the switch. That still needs one real desktop turn to confirm.

### Cross-device, Syncthing-style: one key per device, mutual TLS, pairing by public ID, and your own devices at the top trust tier (ADR-028)

The LAN layer used to be **plaintext HTTP with one shared token for the whole cluster**, and the token rode in every request header. Anyone on the same Wi-Fi who captured one packet could act as you. That got worse with the doorbell (ADR-027): a message to a session in Bypass + `accept` now runs without asking. One token also meant a lost laptop forced re-pairing every machine, and `anyd pair --invite` put the secret into shell history and chat logs.

- **Identity** (copied from [Syncthing](https://docs.syncthing.net/users/security.html)): every device generates an **Ed25519 key and a self-signed certificate** on first start (`~/.anytoany/identity/`, key 0600). Its **device ID is the certificate's SHA-256** in grouped base32. The private key never leaves the machine. Node can't issue X.509 certificates, so the fixed-shape DER is encoded by hand in about 80 lines, with zero dependencies; Node's own `X509Certificate` parses and verifies it in the tests.
- **Pairing exchanges public IDs only**: `anyd pair` shows this device's ID, `anyd pair add <ID>` trusts another, and `anyd pair remove` revokes one device without touching the others. `anyd pair --invite` prints an installer line containing nothing secret. Edits apply to a running daemon immediately.
- **Transport**: device-to-device traffic moved to its own port (console port + 1, default **7434**) over **mutual TLS 1.3** with forward secrecy. Both sides pin the other's fingerprint against their trust list. The client checks *who answered* before sending a single byte. The server refuses unpaired devices (403) and lists them as **pairing requests** in `anyd peers`, never as messages. The sending device is recorded from its verified certificate, not from what the body claims.
- **The console is loopback-only, always.** It no longer binds `0.0.0.0` for peering; the plaintext peer API is gone from it.
- **Trust tiers**: your own devices are `owner`, the top tier. Their messages carry your authority (ADR-016). A future `guest` tier for someone else's devices, delivering data and never commands, is specified in the ADR but deliberately not addable yet.
- **Breaking**: the old `cluster-token` is no longer read, and `--join <token>` / `pair --set` print the new flow. Upgrade both machines, then `pair add` once on each side.
- **Also fixed**: an isolated daemon (`ANYTOANY_HOME`, as used by tests and smoke runs) rewrote **and pruned** the operator's real `~/.claude/agents/any-*` mention agents. Isolated instances now skip that sync.
- **Beyond the LAN?** This is step one of what lets Syncthing cross networks, since identity is now a key and not an IP. Crossing networks would still need discovery and relay servers, which conflicts with ADR-002 (LAN only), so it's a separate decision.
- CI on Node 20 caught a 1-in-128 certificate encoding bug before release: the serial number could get a redundant leading zero, which strict OpenSSL rejects as "illegal padding". INTEGERs are now canonical DER, with a 400-certificate regression test.
- Verified: 424 tests; two real daemons on one machine over real mDNS. Unpaired traffic was refused and recorded as a request; pairing applied live; the message was relayed and stamped with the verified device; the wire showed TLS 1.3 / AES-256-GCM / Ed25519. The console is unreachable from the LAN IP.

### Doorbells: running sessions get their mail now, not on the user's next prompt (ADR-027)

A tally of the daemon log found 251 delivery failures, and **none** of them were in transport between machines. Every one happened at the last step, pushing the message into the agent's session. ADR-023/026 stopped headless-resuming into live sessions, but their mail then waited until the user typed. A survey of the community (agents-can-communicate, agent-talk, openmsg, coder/agentapi …) and the vendors' own channels turned up two official ways in. Both were verified on this machine against throwaway sessions and threads.

- **Codex Desktop, the case the community considered unsolved** ([openai/codex#37450](https://github.com/openai/codex/issues/37450)): `codex queue` (CLI 0.149+) appends to Codex's own shared queue (`~/.codex/queue_1.sqlite`), which Desktop watches for the threads it has open. A message queued into a thread Desktop held ran **within 4 seconds**, and the agent answered with `anyd reply`. Live Codex threads are now delivered this way, and the envelope switches to "reply by running `anyd reply <id>`", since there's no stdout to read a marker from. This path is exempt from the version guard because it never resumes the thread; it was verified with CLI 0.157 queueing into Desktop 0.162. Threads nobody has open still use `exec resume`.
- **Claude, the official inbox socket**: since 2.1.224 every Claude Code session, desktop App ones included, registers an inbox socket in `~/.claude/sessions/<pid>.json`, and an idle session that receives a line starts a turn. The daemon now rings that socket with a content-free "you have mail" frame, and the session's existing pull hook injects the message. If the frame is held or lost, the message is still pending and arrives on the next prompt as before. With `crossSessionInbound: "accept"`, a test session replied **in 7 seconds with no user input**.
- **Gate**: if your sessions default to Bypass permissions and you haven't set `accept`, Claude Code holds every peer frame, so the daemon doesn't ring at all. `anyd doctor` says whether the doorbell is on and how to turn it on. anytoany never edits that setting for you, and never borrows the session's own token to skip its inbound controls.
- **Bug fixed along the way**: ADR-023 detected live Claude sessions by `--resume=` in `ps`, but **desktop-App sessions don't have it**. All four on the test machine were invisible, so anytoany kept headless-resuming into sessions the user had open. That is how the Oct 12 dead letter `d00591bc` happened. The inbox registry now feeds liveness.
- **Honest limit**: a Codex thread running in a read-only or workspace-write sandbox can't reply at all. Codex's sandbox blocks both the mailbox write and loopback HTTP. `anyd reply` now says so plainly, and the envelope tells the agent to put its verdict in its visible answer.

### Codex threads open in Codex Desktop are left for their prompt hook, not resumed into and dead-lettered (ADR-026)

The Codex twin of ADR-023. Of 190 failed Codex deliveries in `daemon.log`, 126 were `thread-store conflict: thread <id> already has an active writer`: 42 messages to 5 threads, each retried exactly 3 times and then dead-lettered, because Codex Desktop had the thread open and a headless `codex exec resume` can't take it over. Unlike the Claude case, the turn never runs at all.

- **Detection reads Codex's own lock**: upstream (`codex-rs/rollout/src/writer_lock.rs`), every writer `flock`s `~/.codex/thread-writer-locks/<thread>.lock` and deletes the file on release. A thread counts as live when its lock file exists **and** some process holds it open, which is asked of `lsof` (read-only, ~75ms, skipped entirely when no lock files exist, cached 2s). A crash-orphaned lock file is not live. anytoany never tries the flock itself, because holding it even briefly could make Codex Desktop fail to open the thread.
- **Skipped, left pending**: `isSessionLive` now covers Codex too, so the dispatcher leaves those messages pending for the thread's `UserPromptSubmit` hook. They also skip the ADR-025 version preflight, since they never go through the global CLI.
- **Fallback**: if resume still hits the lock (race, or no `lsof`), the error is terminal (`retry:false`) and reads `codex_thread_busy: codex thread <id> is open in another Codex process (usually Codex Desktop)… NOT delivered…` instead of a raw stderr tail retried three times.

### Check CLI versions before sending — an out-of-date CLI is now a loud error, not a silent dead letter (ADR-025)

Headless delivery resumes a session with the *global* CLI, but the session is usually written by the desktop App, which bundles its own, newer one. On 2026-10-12 a Codex→Claude message failed three times with a bare `exit 1` and an empty stderr: the global `claude` was 2.1.287 and the App was 2.1.295. The ADR-022 pull hook then quietly recovered it, so the message "arrived" and the cause stayed hidden. The same day, the global `codex` (0.157.1) turned out to be behind Codex Desktop (0.162.0-alpha).

- **Refused at send time**: `POST /api/send` and `/api/messages` run a preflight on local targets. If the delivering CLI's `major.minor.patch` is *older* than the session's writer, the send gets `409 {code: "version_mismatch"}` naming both versions and the exact upgrade command, and **nothing is queued**. `anyd send` prints the error and exits 1. A newer CLI, or a difference only in the prerelease tag, passes, because that direction resumes fine (today's CLI 2.1.296 > App 2.1.295). Live, monitored and pull-only targets are exempt: they never go through the CLI.
- **Backstop at delivery**: the claude/codex adapters run the same check before spawning a turn. A mismatch is terminal (`retry:false`, no triple retry) and pops a macOS alert, throttled to once per agent per 10 minutes.
- **Recipient side**: a version-mismatch dead letter is still handed over, so no mail is lost. It now arrives framed as a `DELIVERY ERROR` the agent must relay, upgrade command included, instead of the soothing "couldn't be reached".
- **Where the versions come from**: Claude records `version` on every transcript line, and the last one is used. Codex records `cli_version` only once, at thread creation (a three-month-old thread still says 0.144.2). Its writer is therefore inferred as the highest version the same originator (`Codex Desktop`) was seen running at or before the thread's last activity. Only running against real sessions exposed this; the unit tests had passed.
- `--version` is probed with a 60s cache, so an upgrade takes effect without restarting the daemon. The skill now tells agents to surface a `version_mismatch` to the user rather than retry.

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
