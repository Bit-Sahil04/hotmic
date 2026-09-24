// Spawns two real native helpers (as Chrome would) and checks they relay
// envelopes to each other over the LAN (multicast loopback on this machine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HOST = fileURLToPath(new URL('../native-host/hotmic_host.mjs', import.meta.url));
const hasLan = Object.values(os.networkInterfaces()).flat().some((a) => a && !a.internal && (a.family === 'IPv4' || a.family === 4));

function startHost(port) {
  const child = spawn(process.execPath, [HOST], { env: { ...process.env, HOTMIC_PORT: String(port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      messages.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
      buf = buf.subarray(4 + len);
    }
  });
  const send = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([hdr, body]));
  };
  return { child, messages, send };
}

const waitFor = async (pred, ms = 4000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

test('two helpers relay envelopes over the LAN; junk and own echoes are dropped', { skip: !hasLan && 'no IPv4 LAN interface' }, async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const a = startHost(port);
  const b = startHost(port);
  try {
    assert.ok(await waitFor(() => a.messages.some((m) => m.type === 'ready') && b.messages.some((m) => m.type === 'ready')), 'helpers ready');
    const env = JSON.stringify({ p: 'hotmic', v: 1, r: 'tag', i: 'aaaa', c: 'bbbb' });
    a.send({ type: 'send', data: env });
    a.send({ type: 'send', data: 'not an envelope' });
    assert.ok(await waitFor(() => b.messages.some((m) => m.type === 'recv')), 'peer received');
    await new Promise((r) => setTimeout(r, 300));
    const got = b.messages.filter((m) => m.type === 'recv');
    assert.equal(got.length, 1, 'duplicates (multicast+broadcast) collapsed');
    assert.equal(got[0].data, env);
    assert.equal(a.messages.filter((m) => m.type === 'recv').length, 0, 'own echo suppressed');
  } finally {
    a.child.stdin.end();
    b.child.stdin.end();
    await new Promise((r) => setTimeout(r, 200));
    a.child.kill();
    b.child.kill();
  }
});

test('helper exits when Chrome closes the pipe', async () => {
  const h = startHost(40000 + Math.floor(Math.random() * 20000));
  await waitFor(() => h.messages.some((m) => m.type === 'ready'));
  const exited = new Promise((r) => h.child.on('exit', r));
  h.child.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.notEqual(code, 'timeout');
});
