import type { CollabDoc, ProgressSection } from './doc.js';

/**
 * Merge two copies of the SAME collaboration document into one convergent state
 * (Phase 4 / M3 cross-device sync). Designed so that two machines exchanging
 * docs both reach an identical result — a small CRDT-style merge:
 *
 *  - Lead-owned region (lead / tasks / body): last-writer-wins by `updated`.
 *    The lead is the single writer of this region, so the newer edit is correct.
 *  - Progress sections: append-only per agent, and each agent writes only on its
 *    own machine — so the fuller section (more entries) is the more recent one.
 *  - Ties (equal timestamps / equal entry counts) are broken by a deterministic
 *    content comparison, not by argument order, so both directions converge.
 */

/** Deterministic, symmetric total order over strings (length, then lexicographic). */
function cmpStr(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Which side owns the lead region: newer `updated`, ties broken by content. */
function leadWinner(local: CollabDoc, incoming: CollabDoc): CollabDoc {
  if (incoming.updated > local.updated) return incoming;
  if (incoming.updated < local.updated) return local;
  const key = (d: CollabDoc) => JSON.stringify({ lead: d.lead, tasks: d.tasks, body: d.body });
  return cmpStr(key(incoming), key(local)) > 0 ? incoming : local;
}

/** The fuller progress section for one agent: more entries, ties by content. */
function pickSection(a: ProgressSection, b: ProgressSection): ProgressSection {
  if (a.entries.length !== b.entries.length) return a.entries.length > b.entries.length ? a : b;
  return cmpStr(a.entries.join('\n'), b.entries.join('\n')) >= 0 ? a : b;
}

export function mergeDoc(local: CollabDoc, incoming: CollabDoc): CollabDoc {
  if (local.conversationId !== incoming.conversationId) {
    throw new Error(
      `cannot merge different conversations: ${local.conversationId} vs ${incoming.conversationId}`,
    );
  }

  const winner = leadWinner(local, incoming);

  // union of agents, stable order: local's agents first, then incoming-only ones
  const agents: string[] = [];
  for (const p of [...local.progress, ...incoming.progress]) {
    if (!agents.includes(p.agent)) agents.push(p.agent);
  }
  const find = (doc: CollabDoc, agent: string): ProgressSection | undefined =>
    doc.progress.find((p) => p.agent === agent);
  const progress: ProgressSection[] = agents.map((agent) => {
    const l = find(local, agent);
    const i = find(incoming, agent);
    const section = l && i ? pickSection(l, i) : (l ?? i)!;
    return { agent, entries: [...section.entries] };
  });

  return {
    conversationId: local.conversationId,
    lead: winner.lead,
    tasks: winner.tasks.map((t) => ({ ...t })),
    body: winner.body,
    updated: local.updated > incoming.updated ? local.updated : incoming.updated,
    progress,
  };
}
