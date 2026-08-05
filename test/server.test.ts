import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../src/adapters/types.js';
import { startConsoleServer, type RunningServer } from '../src/daemon/server.js';
import { createDb } from '../src/mailbox/db.js';
import { createMailbox, type Mailbox } from '../src/mailbox/mailbox.js';

const CLAUDE_A = { agent: 'claude', sessionId: 'aaaa1111-0000-4000-8000-000000000001' };
const CODEX_B = { agent: 'codex', sessionId: 'bbbb2222-0000-4000-8000-000000000002' };

const DIRECTORY: SessionInfo[] = [
  { agent: 'claude', sessionId: CLAUDE_A.sessionId, title: '后端', cwd: '/w/a', lastActiveAt: 1 },
  { agent: 'codex', sessionId: CODEX_B.sessionId, title: '前端', cwd: '/w/b', lastActiveAt: 2 },
];

const PORT = 17433;
const base = `http://127.0.0.1:${PORT}`;

describe('console server', () => {
  let mailbox: Mailbox;
  let server: RunningServer;

  beforeAll(() => {
    mailbox = createMailbox(createDb(':memory:'));
    server = startConsoleServer({ mailbox, directory: async () => DIRECTORY, port: PORT, changePollMs: 60_000 });
  });
  afterAll(() => server.close());

  it('serves the web ui at /', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('anytoany console');
  });

  it('GET /api/sessions returns the directory', async () => {
    const { sessions } = (await (await fetch(base + '/api/sessions')).json()) as { sessions: SessionInfo[] };
    expect(sessions).toHaveLength(2);
  });

  it('POST /api/messages creates a conversation and message', async () => {
    const r = await fetch(base + '/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: CLAUDE_A, to: CODEX_B, text: 'from webui test' }),
    });
    expect(r.status).toBe(201);
    const { message } = (await r.json()) as { message: { id: string; conversationId: string; parts: Array<{ via?: string }> } };
    expect(message.parts[0]?.via).toBe('webui');

    const { conversations } = (await (await fetch(base + '/api/conversations')).json()) as {
      conversations: Array<{ id: string; messageCount: number }>;
    };
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messageCount).toBe(1);

    const { messages } = (await (
      await fetch(`${base}/api/conversations/${message.conversationId}/messages`)
    ).json()) as { messages: Array<{ id: string }> };
    expect(messages[0]?.id).toBe(message.id);
  });

  it('POST /api/messages validates the body', async () => {
    const r = await fetch(base + '/api/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'no refs' }),
    });
    expect(r.status).toBe(400);
  });

  it('retry endpoint rejects non-failed messages with 500 payload', async () => {
    const sent = mailbox.send({ from: CLAUDE_A, to: CODEX_B, text: 'x' });
    const r = await fetch(`${base}/api/messages/${sent.id}/retry`, { method: 'POST' });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/only failed/i);
  });

  it('unknown routes 404', async () => {
    expect((await fetch(base + '/api/nope')).status).toBe(404);
  });
});
