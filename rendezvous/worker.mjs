// HotMic rendezvous server as a Cloudflare Worker (the zero-setup "built-in"
// discovery provider). Same HTTP contract as server.mjs — deploy it once and
// set CONFIG.DEFAULT_DISCOVERY_URL (src/shared/config.js) to your workers.dev
// URL. Free plan: SQLite-backed Durable Objects, 100k requests/day — each
// device costs ~2-6 requests per meeting join.
//
// State lives in one Durable Object per room tag (in-memory maps with TTLs —
// the same semantics as rendezvous/store.mjs). The server is "blind": it only
// ever sees opaque room tags, random device ids and AES-GCM-sealed blobs.
//
// Deploy:
//   cd rendezvous && npx wrangler deploy
// Then set DEFAULT_DISCOVERY_URL to https://<worker>.<subdomain>.workers.dev

const ROOMS = 'rooms'; // single DO namespace; one instance per room tag

const MAX_MASTERS = 16;
const MASTER_TTL_MS = 30000;
const SIGNAL_MAX_AGE_MS = 60000;
const MAX_INBOX = 64;
const MAX_MSG = 16384;

/** One instance per room tag; all room state is in memory, TTL'd. */
export class Room {
  constructor() {
    this.masters = new Map(); // id -> expiry(ms epoch)
    this.inboxes = new Map(); // id -> [{from, data}]
    this.sweep();
  }

  sweep() {
    const now = Date.now();
    for (const [id, exp] of this.masters) if (exp <= now) this.masters.delete(id);
    for (const [id, q] of this.inboxes) {
      for (const m of q) if (m.at + SIGNAL_MAX_AGE_MS <= now) q.splice(q.indexOf(m), 1);
      if (!q.length && !this.masters.has(id)) this.inboxes.delete(id);
    }
    setTimeout(() => this.sweep(), 10000).catch?.(() => {});
  }

  fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    let body = {};
    if (method === 'POST') body = request.json().catch(() => ({}));

    let m;
    if ((m = path.match(/^\/v1\/rooms\/([0-9a-f]{16,64})\/masters$/)) && method === 'GET') {
      const now = Date.now();
      return Response.json([...this.masters.entries()].filter(([, e]) => e > now).map(([id]) => id));
    }
    if ((m = path.match(/^\/v1\/rooms\/([0-9a-f]{16,64})\/masters$/)) && method === 'POST') {
      return body.then(({ id }) => {
        if (!/^[0-9a-f]{8,32}$/.test(id || '')) return json({ error: 'bad id' }, 400);
        const now = Date.now();
        for (const [k, e] of this.masters) if (e <= now) this.masters.delete(k);
        if (!this.masters.has(id) && this.masters.size >= MAX_MASTERS) return json({ error: 'too many masters' }, 409);
        this.masters.set(id, now + MASTER_TTL_MS);
        return json([...this.masters.keys()]);
      });
    }
    if ((m = path.match(/^\/v1\/rooms\/([0-9a-f]{16,64})\/masters\/([0-9a-f]{8,32})$/)) && method === 'DELETE') {
      this.masters.delete(m[2]);
      return new Response(null, { status: 204 });
    }
    if ((m = path.match(/^\/v1\/rooms\/([0-9a-f]{16,64})\/inbox\/([0-9a-f]{8,32})$/)) && method === 'POST') {
      return body.then(({ from, data }) => {
        if (!/^[0-9a-f]{8,32}$/.test(from || '')) return json({ error: 'bad from' }, 400);
        if (typeof data !== 'string' || data.length > MAX_MSG) return json({ error: 'bad data' }, 400);
        if (!this.inboxes.has(m[2])) this.inboxes.set(m[2], []);
        const q = this.inboxes.get(m[2]);
        if (q.length >= MAX_INBOX) return json({ error: 'inbox full' }, 429);
        q.push({ from, data, at: Date.now() });
        return new Response(null, { status: 204 });
      });
    }
    if ((m = path.match(/^\/v1\/rooms\/([0-9a-f]{16,64})\/inbox\/([0-9a-f]{8,32})$/)) && method === 'GET') {
      const waitS = Math.min(Number(url.searchParams.get('wait') || 0), 30);
      const deadline = Date.now() + waitS * 1000;
      const poll = () => {
        const q = this.inboxes.get(m[2]);
        if (q?.length) {
          const out = q.splice(0, q.length).map(({ from, data }) => ({ from, data }));
          if (!q.length && !this.masters.has(m[2])) this.inboxes.delete(m[2]);
          return Response.json(out);
        }
        if (Date.now() >= deadline) return Response.json([]);
        return new Promise((r) => setTimeout(() => r(poll()), 500));
      };
      return poll();
    }
    if (path === '/health') return Response.json({ ok: true });
    return json({ error: 'not found' }, 404);
  }
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
const cors = (body, status = 200) => new Response(body, { status, headers: CORS });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return cors(null, 204);
    const url = new URL(request.url);
    if (url.pathname === '/health') return cors(JSON.stringify({ ok: true }), 200);

    const m = url.pathname.match(/^\/v1\/rooms\/([0-9a-f]{16,64})(\/.*)$/);
    if (!m) return cors(JSON.stringify({ error: 'not found' }), 404);
    const tag = m[1];

    const stub = env.HOTMIC_ROOMS.get(ROOMS, tag);
    // Forward with the room-tag-relative path so the DO sees a stable route.
    const inner = new Request(`https://room/${m[2]}${url.search}`, request);
    const res = await stub.fetch(inner);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};
