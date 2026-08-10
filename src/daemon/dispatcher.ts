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
}

const label = (s: SessionInfo | undefined, fallbackAgent: string, fallbackId: string): string =>
  s ? `@${s.agent}:${s.title}` : `@${fallbackAgent}:${fallbackId.slice(0, 8)}`;

/** Claim and deliver a single message. Returns false when nothing was pending. */
export async function dispatchOnce(opts: DispatcherOptions): Promise<boolean> {
  const claimed = opts.mailbox.claimNextPending();
  if (!claimed) return false;
  const emit = (event: DispatchEvent) => opts.onEvent?.(event);

  const fail = (error: string): true => {
    const failed = opts.mailbox.markFailed(claimed.id, error);
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
  const envelope = renderEnvelope({
    messageId: claimed.id,
    fromLabel: label(sender, claimed.from.agent, claimed.from.sessionId),
    text: claimed.parts.map((p) => p.text).join('\n'),
  });

  let result;
  try {
    result = await adapter.deliver(target, envelope);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  if (!result.ok) return fail(result.error ?? 'delivery failed');

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
