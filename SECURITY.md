# Security Policy

anytoany moves messages between AI agent sessions on your own machines. Its security posture matters — thanks for helping keep it tight.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's [private vulnerability reporting](https://github.com/Ericgood/any-to-any/security/advisories/new) instead. You should get a response within a few days.

## Trust model (what's in scope, and what isn't)

anytoany is built for a **single operator's own cluster**: your machines, on your LAN. Each device has its own Ed25519 key; its device ID is the certificate fingerprint, and devices pair by adding each other's public ID (no shared secret). Device-to-device traffic is mutual TLS 1.3, fingerprint-pinned, and `anyd pair remove` revokes one device ([ADR-028](docs/decisions.md)). Within that boundary agents collaborate as trusted teammates — a message relayed between your own sessions carries your authority (see [ADR-016](docs/decisions.md)). We do **not** try to defend one of your agents against another; the boundary is your paired devices' keys (and, on each machine, your user account), not the message content. If code is already executing inside a paired agent, that's outside anytoany's threat model. A plain-language version, including what anytoany does not protect against, is at [anytoany.dev/security](https://anytoany.dev/security).

In scope for reports:

- **Crossing the cluster boundary** — bypassing the loopback-only guard on console endpoints, or the mutual-TLS fingerprint check on the peer port, so an unpaired host can inject or read messages, or a paired device can pose as another one.
- **Message text escaping into shell execution** — delivery is argv-only by design; a way to make message text reach a shell is a bug.
- **Loop/rate-protection bypass** — anything that lets two agents burn tokens in an unbounded ack loop.
- **Key or session-id disclosure** — a device's private key, or another peer's session ids, leaking to a machine that shouldn't have them.
- **Escalation the owner didn't opt into** — a *sender* (rather than the machine owner's local config) causing an agent to run with full/`--dangerously` permissions.

Explicitly **out of scope**: a receiving agent acting on a message from a peer inside the same paired cluster — that is the intended behavior, not an escalation.

## Design invariants (what "secure" means here)

1. Delivery uses official vendor headless channels only, **argv-only**; no permission-escalating flags are ever injected by a sender. Full-permission execution is a local, per-machine **owner opt-in**, off by default.
2. Nothing leaves the local network; LAN peers must present a certificate whose fingerprint is on the trust list (mutual TLS 1.3); the web console binds to loopback.
3. Loop/rate caps and anti-chatter rules bound agent-to-agent traffic.
