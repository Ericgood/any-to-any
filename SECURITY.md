# Security Policy

anytoany moves messages between AI agent sessions on your own machines. Its security posture matters — thanks for helping keep it tight.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's [private vulnerability reporting](https://github.com/Ericgood/any-to-any/security/advisories/new) instead. You should get a response within a few days.

## Scope of interest

- Prompt-injection escalation through the message envelope (getting a receiving agent to exceed its authorization)
- Bypassing the loopback-only guard on console endpoints, or the cluster-token check on `/api/peer/*`
- Message-text escaping into shell execution (delivery is argv-only by design)
- Loop/rate protection bypasses that could cause unbounded agent-to-agent token burn

## Design invariants (what "secure" means here)

1. Cross-agent messages are delivered as **labelled external data**, never as user instructions.
2. Delivery only uses official vendor headless channels; no permission-escalating flags are ever injected.
3. Nothing leaves the local network; LAN peers require a shared token; the web console binds to loopback.
