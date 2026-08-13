import type { DeliveryAdapter, SessionInfo } from '../adapters/types.js';
import { routeForMessage } from '../cluster/routing.js';
import { renderEnvelope, extractReply } from '../envelope.js';
import type { Mailbox, Message } from '../mailbox/mailbox.js';

export interface DispatchEvent {
  kind: 'delivered' | 'failed' | 'reply-filed' | 'reply-rejected';
  message: Message;
  detail?: string;
}

export interface DispatcherOptions {
  mailbox: Mailbox;
  /** agent name -> delivery adapter */
  adapters: Map<string, DeliveryAdapter>;
  /** Session directory supplier (cached by the caller as needed). */
  directory: () => Promise<SessionInfo[]>;
  onEvent?: (event: DispatchEvent) => void;
  /** This machine's device name; unset disables relay routing (Phase 1 mode). */
  selfDevice?: string;
  /** Hand a message to a paired peer daemon (Phase 2 LAN). */
  relay?: (device: string, message: Message) => Promise<{ ok: boolean; error?: string }>;
  /** When set and a doc exists for the conversation, the delivery envelope
   *  points the recipient at the shared collaboration plan (Phase 4). `ensure`,
   *  when present, lets the first agent↔agent message auto-create a seeded doc
   *  (ADR-018 — the plan is born with the connection). */
  collab?: {
    exists(conversationId: string): boolean;
    ensure?(input: { conversationId: string; lead: string; body?: string }): Promise<unknown>;
  };
  /** A local session actively running `anyd monitor` receives messages live in its
   *  own turn; the dispatcher must NOT resume-deliver to it (which would create an
   *  invisible headless turn). Such messages stay pending for the monitor to pull. */
  isMonitored?: (sessionId: string) => boolean;
}

const label = (s: SessionInfo | undefined, fallbackAgent: string, fallbackId: string): string =>
  s ? `@${s.agent}:${s.title}` : `@${fallbackAgent}:${fallbackId.slice(0, 8)}`;

/** Claim and deliver a single message. Returns false when nothing was pending. */
export async function dispatchOnce(opts: DispatcherOptions): Promise<boolean> {
  // skip local targets that are live-monitoring — they pull messages themselves
  const claimed = opts.mailbox.claimNextPending(
    opts.isMonitored
      ? { skip: (toSession, toDevice) => !toDevice && opts.isMonitored!(toSession) }
      : undefined,
  );
  if (!claimed) return false;
  const emit = (event: DispatchEvent) => opts.onEvent?.(event);

  const fail = (error: string, terminal = false): true => {
    const failed = opts.mailbox.markFailed(claimed.id, error, terminal ? { terminal: true } : undefined);
    emit({ kind: 'failed', message: failed, detail: error });
    return true;
  };

  // Route FIRST — even a reply to the human may be on another device (kimi on
  // mini replying to the user on macbook must relay home, not sit in mini's
  // local inbox). Only a LOCAL user reply is a mailbox-is-the-inbox delivery.
  const route = routeForMessage(claimed, opts.selfDevice ?? '');
  if (route.kind === 'relay') {
    if (!opts.relay) return fail(`target device "${route.device}" requires LAN relay (not configured)`);
    let relayed;
    try {
      relayed = await opts.relay(route.device, claimed);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (!relayed.ok) return fail(relayed.error ?? `relay to ${route.device} failed`);
    const delivered = opts.mailbox.markDelivered(claimed.id);
    emit({ kind: 'delivered', message: delivered, detail: `relayed-to:${route.device}` });
    return true;
  }

  // Local delivery. A reply addressed to the human has no session to resume —
  // landing in this machine's mailbox IS the delivery (read in the console).
  if (claimed.to.agent === 'user') {
    const delivered = opts.mailbox.markDelivered(claimed.id);
    emit({ kind: 'delivered', message: delivered, detail: 'user-inbox' });
    return true;
  }

  let sessions: SessionInfo[];
  try {
    sessions = await opts.directory();
  } catch (e) {
    return fail(`directory scan failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const target = sessions.find(
    (s) => s.agent === claimed.to.agent && s.sessionId === claimed.to.sessionId,
  );
  if (!target) return fail(`target session not found: @${claimed.to.agent}:${claimed.to.sessionId}`);

  const adapter = opts.adapters.get(claimed.to.agent);
  if (!adapter) return fail(`no adapter for agent: ${claimed.to.agent}`);

  const sender = sessions.find(
    (s) => s.agent === claimed.from.agent && s.sessionId === claimed.from.sessionId,
  );
  const senderLabel = label(sender, claimed.from.agent, claimed.from.sessionId);
  const text = claimed.parts.map((p) => p.text).join('\n');

  // ADR-018: the shared plan is born with the connection. The FIRST agent↔agent
  // message auto-creates a seeded doc (lead = initiator, body = the request), so
  // alignment exists from message one instead of being a manual afterthought.
  // The lead decomposes the request into tasks on its turn (driven by the skill).
  if (
    opts.collab?.ensure &&
    claimed.from.agent !== 'user' &&
    claimed.to.agent !== 'user' &&
    !opts.collab.exists(claimed.conversationId)
  ) {
    try {
      await opts.collab.ensure({
        conversationId: claimed.conversationId,
        lead: senderLabel,
        body: `Initial request (from ${senderLabel}):\n${text}`,
      });
    } catch {
      // best-effort — never fail delivery because the doc couldn't be seeded
    }
  }

  const envelope = renderEnvelope({
    messageId: claimed.id,
    fromLabel: senderLabel,
    text,
    // a shared collab doc turns the plain relay into a coordinated hand-off
    ...(opts.collab?.exists(claimed.conversationId)
      ? {
          collab: {
            conversationId: claimed.conversationId,
            selfLabel: label(target, claimed.to.agent, claimed.to.sessionId),
          },
        }
      : {}),
  });

  let result;
  try {
    result = await adapter.deliver(target, envelope);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!result.ok) return fail(result.error ?? 'delivery failed', result.retry === false);

  const delivered = opts.mailbox.markDelivered(claimed.id);
  emit({ kind: 'delivered', message: delivered });

  const replyText = extractReply(result.output ?? '');
  if (replyText) {
    // Anti-pingpong: a BLOCKED status answered with another BLOCKED status is
    // two waiting agents confirming each other — zero information, endless
    // round-trips (each too slow to trip the rate guard). Same for explicit
    // NOOP replies (envelope's "nothing new to add" escape hatch).
    const incoming = claimed.parts.map((p) => p.text).join('\n').trimStart();
    const reply = replyText.trimStart();
    // NOOP as the leading token — followed by whitespace/newline or end — even
    // when the agent over-explains after it ("NOOP\n---\n standing by…").
    const isNoop = /^NOOP(\s|$)/.test(reply);
    const blockedPingpong = incoming.startsWith('BLOCKED') && reply.startsWith('BLOCKED');
    if (isNoop || blockedPingpong) {
      emit({
        kind: 'reply-rejected',
        message: delivered,
        detail: isNoop ? 'noop reply — not filed' : 'blocked-pingpong suppressed',
      });
      return true;
    }
    try {
      const reply = opts.mailbox.reply(claimed.id, replyText, 'auto');
      emit({ kind: 'reply-filed', message: reply });
    } catch (e) {
      // loop/rate protection tripping here is by design — record, don't crash
      emit({
        kind: 'reply-rejected',
        message: delivered,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return true;
}

export interface RunningDispatcher {
  stop(): void;
}

/** Poll the mailbox forever; drains the queue then idles at intervalMs. */
export function startDispatcher(
  opts: DispatcherOptions,
  { intervalMs = 1000 }: { intervalMs?: number } = {},
): RunningDispatcher {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // drain everything currently pending before going back to sleep
      while (!stopped && (await dispatchOnce(opts))) {
        /* keep draining */
      }
    } catch {
      // dispatchOnce already records failures; never let the loop die
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
