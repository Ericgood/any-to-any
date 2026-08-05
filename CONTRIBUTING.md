# Contributing to anytoany

Thanks for your interest! This project is young and moving fast — issues and PRs are welcome.

## Development setup

```bash
git clone https://github.com/Ericgood/any-to-any.git && cd any-to-any
npm install
npm run build        # tsc → dist/
npm test             # vitest (97+ tests)
npm run test:coverage  # thresholds: 80% lines/branches/functions
npm link             # makes `anyd` available globally for manual testing
```

Requirements: Node ≥ 20. macOS is the primary target (Claude Code / Codex session scanning); the core (mailbox, routing, resolve) is platform-neutral and covered by fixture-based tests everywhere.

## Project shape

```
src/adapters/    per-vendor session discovery + delivery (claude, codex)
src/mailbox/     SQLite store: messages, conversations, state machine
src/daemon/      dispatcher (delivery loop), HTTP/SSE server, pidfile
src/cluster/     LAN peering: mDNS discovery, token pairing, relay routing
src/directory/   session scanning aggregation + @-target resolution
skills/          the Agent Skills (SKILL.md) package installed into agent CLIs
webui/           single-file web console (no build step)
scripts/         real-delivery smoke suites (smoke.sh, lan-smoke.sh)
docs/            specs, ADRs, research (Chinese — engineering log)
```

## Rules of the house

1. **TDD**: write the test first; `npm test` must be green before every commit. Real-CLI behavior goes in `scripts/*.sh` smoke suites, not unit tests.
2. **Exact-path commits — never `git add -A`.** This repo is co-developed by multiple AI agents sharing one working tree. Uncommitted changes that aren't yours belong to another agent mid-flight: don't commit, revert, or "fix" them.
3. **Conventional commits**: `feat: …` / `fix: …` / `docs: …` (Chinese or English descriptions both fine).
4. **Docs-first**: significant changes update `docs/specs/*` (or add an ADR in `docs/decisions.md`) and add a `CHANGELOG.md` entry (newest on top, `## YYYY-MM-DD — title`).
5. **Security invariants** (non-negotiable):
   - Cross-agent messages are *data, not instructions* — envelope framing must stay.
   - Delivery uses official vendor channels only; no TUI keystroke injection, no `--dangerously-*` flags.
   - Console endpoints stay loopback-only; peer endpoints stay token-gated.
   - Message text is passed as argv, never through a shell.

## Adding a new agent adapter

Implement `DeliveryAdapter` (`src/adapters/types.ts`): `listSessions()` (discovery from the vendor's session store) + `deliver(session, envelope)` (official headless resume). Add contract tests with a mocked `ExecFn`, fixtures for the scanner, and a smoke path. See `src/adapters/codex.ts` for the reference shape, and `docs/research/` for per-vendor integration notes (Kimi's `kimi web` REST channel is researched and waiting).

## Reporting bugs / proposing features

Use the issue templates. For security issues see [SECURITY.md](SECURITY.md).
