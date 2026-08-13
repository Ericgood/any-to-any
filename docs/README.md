# Engineering docs

> These design records are written **in Chinese** — this project was built in the open by several AI coding agents (Claude, Codex, Kimi, ZCode) coordinating through the very tool they were building. The Chinese docs are the honest, first-hand record of that process. This page is an English map of what's where; the [README](../README.md), [CHANGELOG](../CHANGELOG.md), code, and commit history are all in English.

## Architecture & decisions

| File | What it covers |
|---|---|
| [analysis.md](analysis.md) | Research summary + the overall architecture: session directory, mailbox, delivery channels, LAN peering. |
| [decisions.md](decisions.md) | **ADRs** (numbered, append-only) — every locked-in decision. Highlights: ADR-002 LAN-only (no Tailscale/cloud), ADR-005 per-vendor delivery channels, ADR-006 A2A-aligned message fields, ADR-011 mandatory-verdict envelope, ADR-014 three-party context, ADR-015 CI cost policy, **ADR-016 the trusted-teammate trust model**. |

## Phase specs

| File | What it covers |
|---|---|
| [specs/phase1-mvp.md](specs/phase1-mvp.md) | Same-machine `@` between Claude Code and Codex — the MVP. |
| [specs/phase1-webui.md](specs/phase1-webui.md) | The local web console (IM-style timeline). |
| [specs/phase2-lan.md](specs/phase2-lan.md) | LAN cross-device: mDNS discovery, token pairing, relay routing, directory aggregation. |
| [specs/phase2.5-at-mention.md](specs/phase2.5-at-mention.md) | The `@any` addressing layer — user-confirmed target completion. |
| [specs/phase3-zcode-adapter.md](specs/phase3-zcode-adapter.md) | ZCode (Z.ai) adapter. |
| [specs/phase3-kimi-adapter.md](specs/phase3-kimi-adapter.md) | Kimi Code adapter. |
| [specs/phase3-daemon-persistence.md](specs/phase3-daemon-persistence.md) | Persistent daemon via launchd. |

## Vendor CLI research (first-hand)

Hands-on reverse-engineering of each agent CLI's session storage and headless/resume channels — including the many "the help text says X but the parser rejects it" corrections that shaped the adapters.

| File | What it covers |
|---|---|
| [research/research-claude-code.md](research/research-claude-code.md) | Claude Code integration points. |
| [research/research-codex.md](research/research-codex.md) | Codex CLI multi-session / multi-agent capabilities. |
| [research/research-codex-live-inject.md](research/research-codex-live-inject.md) | Real-time injection into a running Codex session (why it's hard; what's official). |
| [research/research-kimi-zcode-qcode.md](research/research-kimi-zcode-qcode.md) | Kimi Code / ZCode / Amazon Q extensibility & automation surfaces. |
| [research/research-zcode.md](research/research-zcode.md) | ZCode (Z.ai desktop ADE) integration channel. |
| [research/research-protocols-and-projects.md](research/research-protocols-and-projects.md) | Landscape: inter-agent protocols and related OSS projects. |
| [research/github-actions-usage-audit-2026-08-09.md](research/github-actions-usage-audit-2026-08-09.md) | CI minutes-usage audit and the fix. |
