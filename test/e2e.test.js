// End-to-end over real UDP: RoomSession + real crypto + real native helpers,
// wired like the service worker does. Also checks meeting isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../src/shared/config.js';
import { RoomSession, TRANSPORT } from '../src/background/session.js';
import { deriveRoom } from '../src/background/crypto.js';

const HOST = fileURLToPath(new URL('../native-host/hotmic_host.mjs', import.meta.url));
const hasLan = Object.values(os.networkInterfaces()).flat().some((a) => a && !a.internal && (a.family === 'IPv4' || a.family === 4));
const realClock = { now: () => performance.now(), setTimeout, clearTimeout };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function device(port, name, meetingId) {
  const child = spawn(process.execPath, [HOST], { env: { ...process.env, HOTMIC_PORT: String(port) }, stdio: ['pipe', 'pipe', 'ignore'] });
  const room = await deriveRoom(meetingId, { iterations: 1000 });
  const meet = { state: 'MUTED' };
  let session;
  const toHost = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const hdr = Buffer.alloc(4); hdr.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([hdr, body]));
  };
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      if (msg.type === 'ready') session.setTransportState(TRANSPORT.UP);
      if (msg.type === 'recv') {
        const env = JSON.parse(msg.data);
        if (env.r === room.roomTag) room.open(env).then((m) => m && session.receive(m));
      }
    }
  });
  session = new RoomSession({
    clock: realClock, config: CONFIG, meetingId, displayName: name, transportState: TRANSPORT.CONNECTING,
    send: (m) => room.seal(m).then((data) => toHost({ type: 'send', data })),
    sendMeetCommand: ({ id, muted }) => setTimeout(() => {
      meet.state = muted ? 'MUTED' : 'UNMUTED';
      session.onMeetState(meet.state, 'command');
      session.onMicCommandResult({ id, ok: true, mic: meet.state });
    }, 15),
  });
  session.start('MUTED');
  return { session, meet, stop: () => { session.dispose(); setTimeout(() => child.stdin.end(), 100); } };
}

test('real LAN: discovery, consent, PTT ownership, meeting isolation', { skip: !hasLan && 'no IPv4 LAN interface', timeout: 30000 }, async () => {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const sahil = await device(port, 'Sahil', 'abc-defg-hij');
  const samir = await device(port, 'Samir', 'abc-defg-hij');
  const other = await device(port, 'Other', 'zzz-zzzz-zzz'); // different meeting, same LAN
  try {
    sahil.session.join();
    await sleep(2500);
    const s2 = samir.session.snapshot();
    assert.equal(s2.participation, 'PROMPTED');
    assert.equal(s2.prompt, 'Sahil is nearby and is using Microphone Sharing for this meeting.');
    assert.equal(other.session.snapshot().participation, 'IN_MEETING', 'other meeting sees nobody');
    assert.equal(other.session.peers.peers.size, 0);

    samir.session.join();
    await sleep(500);
    sahil.session.onKey('down');
    await sleep(600);
    assert.equal(sahil.meet.state, 'UNMUTED');
    assert.equal(samir.meet.state, 'MUTED');
    assert.equal(samir.session.snapshot().ownership.ownerName, 'Sahil');

    samir.session.onKey('down'); // request during Sahil's first 5 s
    await sleep(1500);
    assert.equal(samir.meet.state, 'MUTED');
    sahil.session.onKey('up');   // release hands over to the waiting requester
    await sleep(800);
    assert.equal(sahil.meet.state, 'MUTED');
    assert.equal(samir.meet.state, 'UNMUTED');
  } finally {
    sahil.stop(); samir.stop(); other.stop();
    await sleep(400);
  }
});
