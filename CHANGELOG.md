# Changelog

Notable changes, newest first. This project is pre-release (`0.0.x`) and built in the open by several AI agents coordinating through the very tool they're building — so the log is candid, including the bugs that shaped the design. A more detailed day-by-day record lives in [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md).

## Unreleased

### Design — collaboration layer (Phase 4, planned)

- Wrote the spec + ADR for a **shared collaboration document** model: the doc (per conversation) becomes the durable coordination state, messages become lightweight events pointing into it, one lead owns the doc while workers append their own progress sections, and the doc syncs across devices. Grounded in research of how Codex subagents and Claude Code agent teams / cross-session messaging actually work — anytoany does the cross-vendor, cross-device, weak-consistency version. See [docs/specs/phase4-collab-doc.md](docs/specs/phase4-collab-doc.md) and ADR-017.


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
