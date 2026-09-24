// Rendezvous server over real HTTP, driven by the extension's SignalClient.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../rendezvous/server.mjs';
import { SignalClient } from '../src/offscreen/signal-client.js';

const TAG = 'cd'.repeat(16);

async function withServer(fn, opts) {
  const server = createServer(opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('masters: register / list / refresh / unregister', () => withServer(async (base) => {
  const c = new SignalClient(base, TAG);
  assert.deepEqual(await c.masters(), []);
  assert.deepEqual(await c.register('aaaaaaaaaaaaaaaa'), ['aaaaaaaaaaaaaaaa']);
  assert.deepEqual(await c.register('bbbbbbbbbbbbbbbb'), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  assert.deepEqual(await c.register('aaaaaaaaaaaaaaaa'), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], 'refresh is idempotent');
  await c.unregister('aaaaaaaaaaaaaaaa');
  assert.deepEqual(await c.masters(), ['bbbbbbbbbbbbbbbb']);
  assert.deepEqual(await new SignalClient(base, 'ef'.repeat(16)).masters(), [], 'rooms are isolated');
}));

test('inbox: long-poll wakes on post; blobs delivered once', () => withServer(async (base) => {
  const c = new SignalClient(base, TAG);
  const t0 = Date.now();
  const waiting = c.take('aaaaaaaaaaaaaaaa', 5);
  await new Promise((r) => setTimeout(r, 150));
  await c.post('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'sealed-blob');
  assert.deepEqual(await waiting, [{ from: 'bbbbbbbbbbbbbbbb', data: 'sealed-blob' }]);
  assert.ok(Date.now() - t0 < 2000, 'returned immediately on post');
  assert.deepEqual(await c.take('aaaaaaaaaaaaaaaa', 0), []);
}));

test('validation, CORS and rate limiting', () => withServer(async (base) => {
  const pre = await fetch(`${base}/v1/rooms/${TAG}/masters`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal((await fetch(`${base}/v1/rooms/not-a-tag/masters`)).status, 404);
  assert.equal((await fetch(`${base}/v1/rooms/${TAG}/masters`, { method: 'POST', body: '{"id":"XYZ"}' })).status, 400);
  assert.equal((await fetch(`${base}/v1/rooms/${TAG}/inbox/aaaaaaaaaaaaaaaa`, {
    method: 'POST', body: JSON.stringify({ from: 'bbbbbbbbbbbbbbbb', data: 'x'.repeat(30000) }),
  })).status, 413);
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await fetch(`${base}/health`)).status);
  assert.ok(statuses.includes(429), 'burst limited');
}, { rateLimit: { perSec: 1, burst: 5 } }));
