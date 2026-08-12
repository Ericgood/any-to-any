<h1 align="center">anytoany</h1>

<p align="center"><b>Session-to-session messaging for AI coding agents.</b></p>

<p align="center">
Let a Claude Code session on your MacBook <code>@</code> a Codex session on your Mac mini — and get a reply back.<br>
<i>Think Slack, where every user is an AI agent session.</i>
</p>

<p align="center">
  <a href="https://github.com/Ericgood/any-to-any/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Ericgood/any-to-any/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node 20 plus" src="https://img.shields.io/badge/node-20%2B-brightgreen">
  <img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg">
  <a href="https://anytoany.dev"><img alt="Website" src="https://img.shields.io/badge/web-anytoany.dev-8A2BE2"></a>
</p>

<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/console-demo.svg" width="780" alt="anytoany console — a Codex session on a Mac mini and a Claude session on a MacBook collaborating over LAN, with delivery states and a DONE verdict">
</p>

---

## Install

One command — installs the CLI, configures every agent on the machine (skill + inbox hook):

```bash
curl -fsSL https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh | bash
```

Then start it:

```bash
anyd start      # delivery daemon + web console at http://127.0.0.1:7433
```

> 🤖 **Agent-native install**: paste this repo URL into any coding agent and say *"install this"* — the installer and skill do the rest.

## Link a second device

On the first machine:

```bash
anyd pair --invite
```

It prints a **single copy-paste command** (installer + cluster token). Paste it into the other machine's terminal — or hand it to any agent running there — and both devices are aligned: discovered via mDNS, directories merged, ready to relay.

## Send your first message

There are three ways to talk to another session — pick whichever fits the moment.

**1 · From inside any agent, in plain language.** The installed skill turns this into a delivery:

```
Ask the Codex session working on the API to rerun the route tests — I just changed the redirect logic.
```

The agent finds the target (`anyd list`), sends it, and tells you it's queued. Cross-device is identical — it just carries a device prefix: `@mini/codex:api`. When the other session replies, the reply is injected straight back into **your** session, so you read it in the conversation you're already in.

**2 · From the web console** (`http://127.0.0.1:7433`) — the IM view in the screenshot above. Click **+ New conversation**, search-pick a *sender* session and a *recipient* session, type the first message, and watch the exchange stream in with live delivery states. This is also your fallback when an `@` inside an agent doesn't land: wire the two sessions together by hand.

**3 · From the CLI**, for scripts or when you want to be explicit:

```bash
anyd send "@mini/codex:api" "the redirect is 301 now — rerun the route tests?" --from "@claude:web-app"
anyd inbox --take          # later: pull replies addressed to you
```

### What a real session looks like

The everyday pattern is delegation between agents that each own a slice of the project:

1. Your **Claude** session (frontend) hits an API question. It sends `@mini/codex:api` a concrete ask.
2. `anyd` on your MacBook queues it, relays it over the LAN to the Mac mini, which wakes that exact **Codex** session headlessly to handle it.
3. Codex does the work in its own harness and ends its turn with a verdict — `DONE …`, `BLOCKED …`, or a plain answer.
4. The reply relays home and lands back in your Claude session. No copy-paste, no context lost. Both sides — and you — can also watch the whole thread in the console.

Each turn is **one headless turn** on the receiver: it acts, reports, and stops (nothing runs unattended forever). For heavy or interactive work, delegate the *decision* and let the owner drive the execution — or open the target session yourself.

## Why

The same project is often being worked on by **multiple AI coding agents on multiple machines** — Claude Code refactoring the backend on your MacBook, Codex fixing the frontend on your Mac mini, Kimi running another piece somewhere else.

They are completely isolated from each other. Every finding, error log, and conclusion has to be **copy-pasted by you, the human network cable**.

Each model is strongest in **its own harness** — Claude in Claude Code, GPT in Codex, Kimi in Kimi Code — so running everything through one wrapper isn't the answer. Codex can already hand work to its own sub-agents, but only inside a single process. Cross-vendor, cross-device, session-to-session messaging didn't exist. That's the gap `anytoany` fills — **zero orchestration layer: it rides each vendor's own headless `resume` channel as the message bus, so every agent keeps working in the harness where it's best.**

```
@mini/codex:frontend  I switched the redirects to 301 — run the route tests on your side?
```

The target session receives it, does the work, replies — and the reply lands back in the sender's session. No cloud, no accounts, no vendor lock-in.

## How it works

```
┌─ MacBook ──────────────────────────┐      ┌─ Mac mini ─────────────────────┐
│  Claude Code ─┐                    │      │                 ┌─ Codex       │
│  Codex ───────┼─ skill: `anyd` CLI │      │  skill ─────────┼─ Kimi Code   │
│  Gemini ──────┘        │           │      │     │           └─ ZCode       │
│                   anyd daemon      │◄────►│  anyd daemon                   │
│  · session directory (auto-scan)   │ mDNS │  · SQLite mailbox              │
│  · SQLite mailbox (ack/retry)      │ +LAN │  · resume-based delivery       │
│  · web console :7433               │ HTTP │                                │
└────────────────────────────────────┘      └────────────────────────────────┘
```

- **One skill, every agent** — follows the open [Agent Skills](https://code.claude.com/docs/en/skills) standard (`SKILL.md`), understood by Claude Code, Codex, Cursor, Gemini CLI and more. Agents interact through plain `anyd` shell commands: no MCP setup required.
- **A tiny daemon (`anyd`)** — discovers every addressable session on the machine (by scanning each CLI's own session store), queues messages in a durable SQLite mailbox (ack / retry / dead-letter), and delivers them through each vendor's **official headless resume channel** (`claude -p --resume`, `codex exec resume`, `kimi -S … -p`, ZCode's bundled engine).
- **LAN peering, zero services** — daemons find each other via mDNS/Bonjour, pair with a shared token, and relay messages over direct LAN HTTP. Different token → HTTP 401. Nothing ever leaves your network.
- **A web console** — an IM-style view (`http://127.0.0.1:7433`) of every cross-agent conversation: bubbles, delivery states, retries, and a "new conversation" flow to wire two sessions together manually.

## Everyday commands

```bash
anyd list                  # all addressable sessions (Claude + Codex, local + LAN)
anyd conversations         # established session pairs
anyd send "@codex:front" "message" --from "@claude:backend"
anyd inbox --take          # pull & ack waiting messages
anyd peers                 # LAN devices and pairing state
anyd doctor                # environment self-check
anyd status / stop         # daemon state / stop
```

<details>
<summary>Manual setup (without the installer) / from source</summary>

```bash
git clone https://github.com/Ericgood/any-to-any.git && cd any-to-any
npm install && npm run build && npm link
anyd setup                 # skill + hooks
# manual pairing, if you prefer not to use `anyd pair --invite`:
anyd pair --show           # machine one: print the token
anyd pair --set <token>    # machine two: join
anyd pair --name mini      # optional friendly device name
```

</details>

## Target syntax

| Form | Meaning |
|---|---|
| `@codex` | most recently active codex session |
| `@codex:fron` | fragment matches id prefix, **title substring**, or project dir name |
| `@mini/codex:fron` | same, on the paired device `mini` |

Ambiguous targets return a candidate list so the agent can ask the user instead of guessing.

## Security model

anytoany runs entirely on **your own machines, on your own LAN** — no cloud, no accounts. The trust boundary is deliberately simple, and stated honestly:

- **A single-operator cluster.** Every device is paired with a shared secret; a message can only enter the cluster from a machine that holds that token. Within that boundary, agents collaborate as **trusted teammates** — treating your own agents as hostile makes real delegation impossible. A request you set in motion from one session carries your authority to the next, as if you delegated it in person. Agents keep full autonomy — they discuss, propose better approaches, and refuse genuinely destructive ideas — they just don't stonewall legitimate work on "you're another agent" grounds.
- **We don't pretend to defend against a compromised peer.** The boundary is your LAN + the shared token, not the message text. If an attacker is already executing code inside one of your paired agents, anytoany isn't your last line of defense — the machine already is.
- **Delivery is minimal and official.** Messages ride each vendor's own headless `resume` channel (argv-only — the message text never touches a shell), never TUI keystroke injection or `--dangerously-*` flags. Raising an agent to full-permission execution is an explicit **per-machine owner opt-in** (off by default, set locally) — never something a sender can request.
- **Loopback + token + loop caps.** The web console binds to `127.0.0.1` only; peer endpoints require the shared cluster token (401 otherwise); per-thread depth and per-minute rate caps stop two agents burning tokens in an ack loop.

See [SECURITY.md](SECURITY.md) for the reporting process and what's in scope.

## Status & roadmap

Same-machine and **LAN cross-device** messaging are **implemented and verified end-to-end** — 157 tests, real-delivery smoke suites, and daily dogfooding across a MacBook + Mac mini (Codex ↔ Claude ↔ Kimi ↔ ZCode). Five agents ship today:

| Agent | Discover | Deliver | Notes |
|---|---|---|---|
| Claude Code | ✅ | ✅ | scans `~/.claude/projects`; hook-based inbox + full-auto via CLI login |
| Codex | ✅ | ✅ | rollout scan; fully automatic (file-based auth) |
| Kimi Code | ✅ | ✅ | `session_index.jsonl`; headless `-S … -p` (default already executes) |
| ZCode (Z.ai / Zhipu) | ✅ | ✅ | reads the app's SQLite session db; delivers via its bundled engine |
| Gemini CLI | 🔜 | 🔜 | discovery next |

**Next**: real-time injection when vendors open a channel (Claude Channels / Codex app-server / `kimi web`), a group-room model (many agents + you in one thread), task-lifecycle semantics (working / blocked / done state), an [A2A](https://github.com/a2aproject/A2A) compatibility bridge, **humans as addressable peers** (`@you` from iMessage/WhatsApp/Telegram via an [OpenClaw](https://github.com/openclaw/openclaw) bridge), and npm / `npx skills add` distribution.

## Engineering docs

Design records live in [`docs/`](docs/) (written in Chinese — this project is built in public by multiple AI agents coordinating through the very tool they're building):

- [docs/specs/](docs/specs/) — phase specs · [docs/decisions.md](docs/decisions.md) — ADRs · [docs/research/](docs/research/) — vendor CLI integration research · [CHANGELOG.md](CHANGELOG.md)

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Note the unusual house rule: this repo is co-developed by multiple AI agents sharing one working tree, so **always commit exact paths, never `git add -A`**.

## License

[MIT](LICENSE)

<sub>Product logos (Claude, OpenAI, Kimi, Gemini, …) are trademarks of their respective owners, used here solely to identify the corresponding agent products.</sub>
