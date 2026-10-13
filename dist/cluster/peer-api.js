import { parse as parseCollabDoc } from '../collab/doc.js';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY_BYTES)
            throw new Error('request body too large');
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
}
const isSessionRef = (v) => typeof v === 'object' &&
    v !== null &&
    typeof v.agent === 'string' &&
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0;
export function createPeerApiHandler(opts) {
    return async (req, res, peer) => {
        const path = new URL(req.url ?? '/', 'https://peer').pathname;
        if (req.method === 'GET' && path === '/api/peer/info') {
            json(res, 200, { device: opts.selfDevice, ...(opts.selfId ? { id: opts.selfId } : {}) });
            return;
        }
        if (req.method === 'GET' && path === '/api/peer/sessions') {
            json(res, 200, { sessions: await opts.localDirectory() });
            return;
        }
        if (req.method === 'POST' && path === '/api/peer/messages') {
            const body = (await readBody(req));
            if (!isSessionRef(body.from) || !isSessionRef(body.to) || typeof body.text !== 'string') {
                json(res, 400, { error: 'expected {contextId?, from, to, text}' });
                return;
            }
            const m = opts.mailbox.send({
                // the authenticated device, not whatever the body claims
                from: { agent: body.from.agent, sessionId: body.from.sessionId, device: peer.name },
                to: { agent: body.to.agent, sessionId: body.to.sessionId }, // target is local here
                text: body.text,
                via: 'relay',
                ...(typeof body.contextId === 'string' && body.contextId ? { contextId: body.contextId } : {}),
            });
            opts.onChange?.();
            json(res, 201, { message: m });
            return;
        }
        // Phase 4 / M3: a peer pushes its copy of a collab doc; we merge convergently.
        if (req.method === 'POST' && path === '/api/peer/collab') {
            if (!opts.collab) {
                json(res, 404, { error: 'collab not enabled on this device' });
                return;
            }
            const body = (await readBody(req));
            if (typeof body.doc !== 'string') {
                json(res, 400, { error: 'expected {doc: <serialized markdown>}' });
                return;
            }
            let incoming;
            try {
                incoming = parseCollabDoc(body.doc);
            }
            catch (e) {
                json(res, 400, { error: `unparseable collab doc: ${e instanceof Error ? e.message : String(e)}` });
                return;
            }
            const merged = await opts.collab.merge(incoming);
            opts.onChange?.();
            json(res, 200, { doc: merged });
            return;
        }
        json(res, 404, { error: 'not found' });
    };
}
//# sourceMappingURL=peer-api.js.map