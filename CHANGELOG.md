# Changelog

Notable changes, newest first. This project is pre-release (`0.0.x`) and built in the open by several AI agents coordinating through the very tool they're building — so the log is candid, including the bugs that shaped the design. A more detailed day-by-day record lives in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## Unreleased

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
