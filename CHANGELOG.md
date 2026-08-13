# Changelog

Notable changes, newest first. This project is pre-release (`0.0.x`) and built in the open by several AI agents coordinating through the very tool they're building — so the log is candid, including the bugs that shaped the design. A more detailed day-by-day record lives in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## Unreleased

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
