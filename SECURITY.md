# Security Policy

anytoany moves messages between AI agent sessions on your own machines. Its security posture matters — thanks for helping keep it tight.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's [private vulnerability reporting](https://github.com/Ericgood/any-to-any/security/advisories/new) instead. You should get a response within a few days.

## Trust model (what's in scope, and what isn't)

anytoany is built for a **single operator's own cluster**: your machines, on your LAN, paired with a shared secret. Within that boundary agents collaborate as trusted teammates — a message relayed between your own sessions carries your authority (see [ADR-016](docs/decisions.md)). We do **not** try to defend one of your agents against another; the boundary is the LAN + the shared token, not the message content. If code is already executing inside a paired agent, that's outside anytoany's threat model.

In scope for reports:

- **Crossing the cluster boundary** — bypassing the loopback-only guard on console endpoints, or the cluster-token check on `/api/peer/*`, so an unpaired host can inject or read messages.
- **Message text escaping into shell execution** — delivery is argv-only by design; a way to make message text reach a shell is a bug.
- **Loop/rate-protection bypass** — anything that lets two agents burn tokens in an unbounded ack loop.
- **Token or session-id disclosure** — the cluster token or another peer's session ids leaking to a machine that shouldn't have them.
- **Escalation the owner didn't opt into** — a *sender* (rather than the machine owner's local config) causing an agent to run with full/`--dangerously` permissions.

Explicitly **out of scope**: a receiving agent acting on a message from a peer inside the same paired cluster — that is the intended behavior, not an escalation.

## Design invariants (what "secure" means here)

1. Delivery uses official vendor headless channels only, **argv-only**; no permission-escalating flags are ever injected by a sender. Full-permission execution is a local, per-machine **owner opt-in**, off by default.
2. Nothing leaves the local network; LAN peers require a shared token; the web console binds to loopback.
3. Loop/rate caps and anti-chatter rules bound agent-to-agent traffic.
