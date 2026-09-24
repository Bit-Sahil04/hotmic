import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, IDS } from './sim.js';
import { TRANSPORT } from '../src/background/session.js';

const settle = (w) => w.run(2500); // > SYNC_MS so everyone has heard everyone

function expectSafe(w) {
  assert.deepEqual(w.violations, [], `more than one participant unmuted: ${JSON.stringify(w.violations.slice(0, 3))}`);
}

// ---------------------------------------------------------------------------
// Consent / discovery

test('meeting detected, nearby device prompts with the required text', () => {
  const w = new World();
  w.add('sahil', { join: true });
  w.add('samir');
  settle(w);
  const snap = w.nodes.samir.session.snapshot();
  assert.equal(snap.participation, 'PROMPTED');
  assert.equal(snap.prompt, 'Sahil is nearby and is using Microphone Sharing for this meeting.');
  // never auto-joined
  assert.equal(w.nodes.samir.session.consent.joined, false);
});

test('a user can join alone and use PTT without any other participant', () => {
  const w = new World();
  const a = w.add('sahil', { transport: TRANSPORT.UP });
  settle(w);
  assert.equal(a.session.snapshot().participation, 'IN_MEETING');
  assert.ok(a.session.join());
  w.run(100);
  w.pttDown('sahil');
  w.run(300);
  assert.equal(a.session.ownership.state, 'OWNER');
  assert.equal(a.meet.state, 'UNMUTED');
  w.pttUp('sahil');
  w.run(500);
  assert.equal(a.session.ownership.state, 'NO_OWNER');
  assert.equal(a.session.ownership.record.owner, null);
  assert.equal(a.meet.state, 'MUTED');
});

test('local-only mode (LAN helper not installed) still allows sharing alone', () => {
  const w = new World();
  const a = w.add('sahil', { transport: TRANSPORT.UNAVAILABLE, join: true });
  w.pttDown('sahil');
  w.run(200);
  assert.equal(a.meet.state, 'UNMUTED');
  assert.equal(a.session.snapshot().localOnly, true);
});

test('declining: no coordination, not enforced, not visible to others', () => {
  const w = new World();
  w.add('sahil', { join: true });
  const b = w.add('samir');
  settle(w);
  assert.ok(b.session.decline());
  w.run(4000);
  // Samir is free to use Meet normally
  b.meet.manual('UNMUTED');
  w.run(1000);
  assert.equal(b.meet.state, 'UNMUTED');
  // Samir no longer appears to Sahil
  const snap = w.nodes.sahil.session.snapshot();
  assert.equal(snap.nearby.length, 0);
  assert.equal(snap.participants.length, 1);
});

test('devices in other meetings never see each other (room identity includes meeting)', async () => {
  const { deriveRoom } = await import('../src/background/crypto.js');
  const a = await deriveRoom('abc-defg-hij', { iterations: 1000 });
  const b = await deriveRoom('xyz-wxyz-xyz', { iterations: 1000 });
  assert.notEqual(a.roomTag, b.roomTag);
  const env = await a.seal({ hello: 1 });
  assert.equal(await b.open(JSON.parse(env)), null);
  assert.deepEqual(await a.open(JSON.parse(env)), { hello: 1 });
});

// ---------------------------------------------------------------------------
// PTT / toggle

test('PTT acquires, mutes others; release releases', () => {
  const w = new World();
  const a = w.add('sahil', { join: true });
  const b = w.add('samir', { join: true });
  settle(w);
  w.pttDown('samir');
  w.run(300);
  assert.deepEqual(w.owners(), ['samir']);
  assert.equal(b.meet.state, 'UNMUTED');
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(a.session.snapshot().ownership.ownerName, 'Samir');
  w.pttUp('samir');
  w.run(400);
  assert.deepEqual(w.owners(), []);
  assert.equal(b.meet.state, 'MUTED');
  assert.equal(a.session.ownership.record.owner, null);
  expectSafe(w);
});

test('toggle mode acquires and releases', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  w.add('samir', { join: true });
  settle(w);
  w.tap('sahil');
  w.run(300);
  assert.equal(a.meet.state, 'UNMUTED');
  w.run(1000);
  w.tap('sahil');
  w.run(300);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(a.session.ownership.state, 'NO_OWNER');
  expectSafe(w);
});

test('rapid toggling ON OFF ON OFF is debounced', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  const epoch0 = w.rec('sahil').epoch;
  w.tap('sahil'); w.run(50);  // ON
  w.tap('sahil'); w.run(50);  // ignored
  w.tap('sahil'); w.run(50);  // ignored
  w.tap('sahil'); w.run(50);  // ignored
  w.run(500);
  assert.equal(a.session.input.toggle.state, 'ON');
  assert.equal(a.meet.state, 'UNMUTED');
  assert.equal(w.rec('sahil').epoch, epoch0 + 1, 'exactly one acquire');
});

test('duplicate keydown without keyup (no repeat flag) = one toggle', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  a.session.onKey('down', false);
  w.run(500);
  a.session.onKey('down', false); // duplicate, key never went up
  w.run(500);
  assert.equal(a.session.input.toggle.state, 'ON');
});

test('PTT key repeat and bouncing do not create repeated acquire/release', () => {
  const w = new World();
  const a = w.add('sahil', { join: true });
  settle(w);
  const e0 = w.rec('sahil').epoch;
  w.pttDown('sahil');
  for (let i = 0; i < 20; i++) { a.session.onKey('down', true); w.run(30); } // auto-repeat
  a.session.onKey('down', false); // duplicate keydown
  w.run(100);
  w.pttUp('sahil'); w.run(40); w.pttDown('sahil'); // bounce within release debounce
  w.run(500);
  assert.equal(a.session.ownership.state, 'OWNER');
  assert.equal(w.rec('sahil').epoch, e0 + 1);
  w.pttUp('sahil');
  w.run(400);
  assert.equal(w.rec('sahil').epoch, e0 + 2, 'exactly one release');
  assert.equal(a.meet.state, 'MUTED');
});

test('PTT tap shorter than debounce is ignored', () => {
  const w = new World();
  const a = w.add('sahil', { join: true });
  settle(w);
  w.pttDown('sahil'); w.run(5); w.pttUp('sahil');
  w.run(500);
  assert.equal(a.session.ownership.state, 'NO_OWNER');
  assert.equal(a.meet.commands, 0);
});

test('PTT held + focus lost / tab hidden => fail safe release', () => {
  for (const reason of ['blur', 'hidden']) {
    const w = new World();
    const a = w.add('sahil', { join: true });
    settle(w);
    w.pttDown('sahil');
    w.run(300);
    assert.equal(a.meet.state, 'UNMUTED');
    a.session.onFocusLost(reason);
    w.run(200);
    assert.equal(a.meet.state, 'MUTED');
    assert.equal(a.session.ownership.record.owner, null);
    // the stale key-up that arrives later is harmless
    w.pttUp('sahil');
    w.run(300);
    assert.equal(a.session.ownership.state, 'NO_OWNER');
  }
});

test('missed key-up is bounded by PTT_MAX_HOLD_MS', () => {
  const w = new World({ config: { PTT_MAX_HOLD_MS: 20000 } });
  const a = w.add('sahil', { join: true });
  settle(w);
  w.pttDown('sahil');
  w.run(21000);
  assert.equal(a.meet.state, 'MUTED');
});

// ---------------------------------------------------------------------------
// Ownership rules

test('simultaneous PTT: exactly one owner, deterministic (lower device id)', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const w = new World({ net: { latency: 3, jitter: 20, seed } });
    w.add('sahil', { join: true });
    w.add('samir', { join: true });
    settle(w);
    w.pttDown('samir');
    w.pttDown('sahil');
    w.run(1000);
    assert.deepEqual(w.owners(), ['sahil'], `seed ${seed}`);
    assert.deepEqual(w.rec('sahil'), w.rec('samir'));
    expectSafe(w);
  }
});

test('ownership cannot transfer during the first 5 seconds; can after', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil');
  w.run(300);
  const epochOwned = w.rec('sahil').epoch;
  w.run(1000);            // Sahil has held ~1.3 s
  w.pttDown('samir');     // request
  w.run(3000);            // ~4.3 s held
  assert.deepEqual(w.owners(), ['sahil']);
  assert.equal(b.session.ownership.state, 'REQUESTED');
  assert.equal(b.meet.state, 'MUTED');
  w.run(1500);            // passes 5 s (activity unknown => no deferral)
  assert.deepEqual(w.owners(), ['samir']);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(b.meet.state, 'UNMUTED');
  assert.equal(w.rec('samir').epoch, epochOwned + 1, 'epoch increments on transfer');
  assert.equal(a.session.input.toggle.state, 'OFF', 'pre-empted toggle turns off (no ping-pong)');
  expectSafe(w);
});

test('owner audio activity defers an eligible transfer, bounded by ACTIVITY_MAX_DEFER_MS', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  w.add('samir', { join: true });
  settle(w);
  w.tap('sahil');
  w.run(300);
  const speak = setIntervalSim(w, () => a.session.onActivity(0.3), 200);
  w.pttDown('samir');
  w.run(6000);                   // > 5 s held, but owner is active; defer started at 5 s
  assert.deepEqual(w.owners(), ['sahil']);
  w.run(2800);                   // defer bound (3 s) exceeded
  assert.deepEqual(w.owners(), ['samir']);
  speak.stop();
  expectSafe(w);
});

test('idle owner (activity known, silent) transfers right after 5 s', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  w.add('samir', { join: true });
  settle(w);
  w.tap('sahil');
  w.run(300);
  const quiet = setIntervalSim(w, () => a.session.onActivity(0.0), 200);
  w.pttDown('samir');
  w.run(5200);
  assert.deepEqual(w.owners(), ['samir']);
  quiet.stop();
});

test('owner releasing hands the mic to the waiting requester', () => {
  const w = new World();
  w.add('sahil', { join: true });
  const b = w.add('samir', { join: true });
  settle(w);
  w.pttDown('sahil'); w.run(300);
  w.pttDown('samir'); w.run(1000);
  w.pttUp('sahil'); w.run(500);
  assert.deepEqual(w.owners(), ['samir']);
  assert.equal(b.meet.state, 'UNMUTED');
  expectSafe(w);
});

test('owner manually mutes in Meet => ownership released', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.meet.manual('MUTED');
  w.run(300);
  assert.equal(a.session.ownership.state, 'NO_OWNER');
  assert.equal(w.rec('samir').owner, null);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(a.session.input.toggle.state, 'OFF');
});

test('non-owner manually unmutes => immediately re-muted, owner unchanged', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  const rec = { ...w.rec('sahil') };
  b.meet.manual('UNMUTED');
  w.run(100);
  assert.equal(b.meet.state, 'MUTED');
  assert.deepEqual(w.rec('samir'), rec);
  assert.deepEqual(w.owners(), ['sahil']);
  assert.equal(a.meet.state, 'UNMUTED');
});

test('non-owner manual unmute with no owner is also reverted', () => {
  const w = new World();
  const a = w.add('sahil', { join: true });
  settle(w);
  a.meet.manual('UNMUTED');
  w.run(100);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(a.session.ownership.record.owner, null);
});

test('owner disconnects (Wi-Fi lost) => lease expires => NO_OWNER, owner fenced muted', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  w.add('sheev', { join: true });
  settle(w);
  w.tap('sahil'); w.run(500);
  assert.equal(a.meet.state, 'UNMUTED');
  w.net.isolate('sahil');
  w.run(4000);
  assert.equal(w.rec('samir').owner, null);
  assert.equal(w.rec('sheev').owner, null);
  assert.equal(a.meet.state, 'MUTED', 'owner fences itself before others can claim');
  // next request can acquire
  w.pttDown('samir');
  w.run(500);
  assert.deepEqual(w.owners(), ['samir']);
  expectSafe(w);
});

test('owner device disappears entirely (crash / Chrome closed / sleep): others expire it', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(500);
  a.online = false;             // no more packets either way
  w.run(3500);
  assert.equal(w.rec('samir').owner, null);
  assert.equal(b.meet.state, 'MUTED');
});

test('Meet tab closed / leaving the call releases immediately and cleans up', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.session.dispose('meet tab closed');
  w.run(100);
  assert.equal(w.rec('samir').owner, null);
  assert.equal(b.session.snapshot().participants.length, 1, 'peer removed immediately via leave');
  assert.equal(a.session.consent.state, 'NOT_IN_MEETING');
  assert.equal(a.meet.state, 'MUTED');
  // a brand-new session (e.g. rejoin / refresh) does not inherit stale ownership
  delete w.nodes.sahil;
  const a2 = w.add('sahil', { join: true, id: 'a000000000000009' });
  w.run(2000);
  assert.equal(a2.session.ownership.state, 'NO_OWNER');
  assert.equal(a2.meet.state, 'MUTED');
});

test('two users join at exactly the same time converge to the same state', () => {
  const w = new World({ net: { latency: 2, jitter: 10 } });
  w.add('sahil');
  w.add('samir');
  w.nodes.sahil.session.join();
  w.nodes.samir.session.join();
  w.run(3000);
  assert.deepEqual(w.rec('sahil'), w.rec('samir'));
  assert.equal(w.nodes.sahil.session.snapshot().participants.length, 2);
  assert.equal(w.nodes.samir.session.snapshot().participants.length, 2);
});

test('device joining after someone owns the mic joins muted and does not disturb the owner', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  w.tap('sahil'); w.run(500);
  const rec = { ...w.rec('sahil') };
  const c = w.add('sheev');       // opens Meet later
  w.run(200);
  c.session.join();                // joins immediately (before sync) and even presses PTT
  w.pttDown('sheev');
  w.run(3000);
  assert.deepEqual(w.owners(), ['sahil']);
  assert.deepEqual(w.rec('sheev'), rec);
  assert.equal(c.meet.state, 'MUTED');
  assert.equal(a.meet.state, 'UNMUTED');
  expectSafe(w);
});

test('stale messages with an old epoch cannot change ownership', () => {
  const w = new World();
  w.add('sahil', { join: true });
  const b = w.add('samir', { join: true });
  settle(w);
  w.pttDown('sahil'); w.run(300);
  const captured = w.net.sent.filter((m) => m.d === IDS.sahil && m.k === 'hb').at(-1);
  w.pttUp('sahil'); w.run(300);
  w.pttDown('samir'); w.run(300);
  const rec = { ...w.rec('samir') };
  // replay Sahil's old "I own it" heartbeat with a fresh seq
  b.session.receive({ ...captured, s: captured.s + 1000, ts: w.clock.wallNow() });
  w.run(100);
  assert.deepEqual(w.rec('samir'), rec);
  assert.deepEqual(w.owners(), ['samir']);
});

test('malformed messages are ignored', () => {
  const w = new World();
  const a = w.add('sahil', { join: true });
  settle(w);
  const bad = [null, 1, 'x', {}, { k: 'hb' }, { k: 'hb', v: 1, d: 'zz', s: 1, ts: 1 },
    { k: 'hb', v: 1, d: IDS.samir, s: 1, ts: w.clock.wallNow(), n: 'x', st: 'joined', m: 'UNMUTED', syn: true, r: { e: -1, o: null, h: 0 }, w: null, a: {} },
    { k: 'hb', v: 1, d: IDS.samir, s: 1, ts: w.clock.wallNow(), n: 'x', st: 'joined', m: 'LOUD', syn: true, r: { e: 1, o: null, h: 0 }, w: null, a: {} }];
  for (const m of bad) a.session.receive(m);
  w.run(100);
  assert.equal(a.session.peers.peers.size, 0);
});

// ---------------------------------------------------------------------------
// Fail-safe

test('transport lost => owner muted and claims blocked until reconnected', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.session.setTransportState(TRANSPORT.LOST);
  w.run(200);
  assert.equal(a.meet.state, 'MUTED');
  w.run(500);
  w.tap('sahil'); w.run(500);
  assert.equal(a.meet.state, 'MUTED');
  assert.match(a.session.snapshot().warning, /lost/);
  a.session.setTransportState(TRANSPORT.UP);
  w.run(2000);
  w.tap('sahil'); w.run(500);
  assert.equal(a.meet.state, 'UNMUTED');
});

test('Meet state cannot be determined => owner releases, no claims', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.meet.state = 'UNKNOWN';
  a.session.onMeetState('UNKNOWN', 'external');
  w.run(200);
  assert.equal(a.session.ownership.record.owner, null);
  assert.notEqual(a.session.ownership.state, 'OWNER');
});

test('unmute that Meet does not honour => release and mark inconsistent', () => {
  const w = new World();
  const a = w.add('sahil', { join: true });
  settle(w);
  a.meet.broken = true;
  w.pttDown('sahil');
  w.run(6000);
  assert.equal(a.session.ownership.record.owner, null);
  assert.equal(a.session.snapshot().ownership.lastEvent, 'Meet did not unmute');
  assert.equal(a.meet.state, 'MUTED');
});

test('mute that Meet does not honour => marked inconsistent, keeps retrying, owner fences', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  b.meet.broken = true;
  b.meet.manual('UNMUTED');       // Samir unmutes and the extension cannot re-mute
  w.run(6000);
  const snap = b.session.snapshot();
  assert.equal(snap.mic.inconsistent, true);
  assert.match(snap.warning, /did not mute/);
  assert.equal(a.meet.state, 'MUTED', 'owner fences rather than having two unmuted');
  const before = b.meet.commands;
  w.run(5000);
  assert.ok(b.meet.commands > before, 'mute retried slowly forever');
});

test('laptop sleep/wake => fail closed and resync', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.online = false;
  w.clock.sleep(60_000);   // everybody's timers are late; Sahil was asleep
  a.online = true;
  w.run(3000);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(w.rec('sahil').owner, null);
  assert.deepEqual(w.rec('sahil'), w.rec('samir'));
});

test('lossy network with random PTT use never has two participants unmuted', () => {
  for (const seed of [11, 12, 13]) {
    const w = new World({ net: { latency: 5, jitter: 60, loss: 0.2, seed } });
    const names = ['sahil', 'samir', 'sheev'];
    for (const n of names) w.add(n, { join: true });
    settle(w);
    const r = mulberry(seed);
    const held = {};
    for (let step = 0; step < 300; step++) {
      const n = names[Math.floor(r() * names.length)];
      if (held[n]) { w.pttUp(n); held[n] = false; } else { w.pttDown(n); held[n] = true; }
      w.run(50 + Math.floor(r() * 1500));
    }
    for (const n of names) if (held[n]) w.pttUp(n);
    w.run(8000);
    expectSafe(w);
    assert.ok(w.owners().length <= 1);
    assert.deepEqual(w.rec('sahil'), w.rec('samir'));
    assert.deepEqual(w.rec('samir'), w.rec('sheev'));
  }
});

test('protocol never carries audio or meeting content: only whitelisted metadata keys', async () => {
  const { HB_KEYS, LEAVE_KEYS } = await import('../src/background/messages.js');
  const w = new World();
  w.add('sahil', { join: true });
  w.add('samir', { join: true });
  settle(w);
  w.pttDown('sahil'); w.run(1000); w.pttUp('sahil');
  w.nodes.samir.session.dispose();
  w.run(500);
  assert.ok(w.net.sent.length > 5);
  for (const m of w.net.sent) {
    const allowed = m.k === 'hb' ? HB_KEYS : LEAVE_KEYS;
    for (const k of Object.keys(m)) assert.ok(allowed.includes(k), `unexpected key ${k}`);
    assert.ok(JSON.stringify(m).length < 1024);
  }
});

// helpers ---------------------------------------------------------------------

function setIntervalSim(w, fn, ms) {
  let on = true;
  const loop = () => { if (!on) return; fn(); w.clock.setTimeout(loop, ms); };
  loop();
  return { stop: () => { on = false; } };
}

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('asymmetric partition (member cannot hear owner): owner fences before member can claim', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(500);
  w.net.blocked.add('sahil>samir'); // Samir stops hearing Sahil, Sahil still hears Samir
  w.pttDown('samir');               // Samir keeps asking
  w.run(8000);
  expectSafe(w);
  assert.equal(a.meet.state, 'MUTED');
});

test('network change (host reports interface change) fails closed', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.session.onNetworkChange();
  w.run(200);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(a.session.synced, false);
  w.run(2000);
  assert.equal(a.session.synced, true);
});

test('leaving sharing mutes, releases and stops enforcement; rejoining works', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  a.session.leaveSharing();
  w.run(200);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(w.rec('samir').owner, null);
  a.meet.manual('UNMUTED');         // no longer enforced
  w.run(500);
  assert.equal(a.meet.state, 'UNMUTED');
  a.meet.manual('MUTED');
  assert.ok(a.session.join());
  w.run(2500);
  assert.equal(b.session.snapshot().participants.length, 2);
  w.run(500);
  w.tap('sahil'); w.run(500);
  assert.deepEqual(w.owners(), ['sahil']);
});

test('popup snapshot: owner notification data and participants', () => {
  const w = new World();
  w.add('sahil', { join: true, mode: 'toggle' });
  const b = w.add('samir', { join: true });
  w.add('sheev', { join: true });
  settle(w);
  w.tap('sahil'); w.run(300);
  w.run(17000);
  const s = b.session.snapshot();
  assert.equal(s.ownership.ownerName, 'Sahil');
  assert.ok(Math.abs(s.ownership.ownerHeldMs - 17000) < 400, `held ${s.ownership.ownerHeldMs}`);
  assert.deepEqual(s.participants.map((p) => [p.name, p.hasMic, p.mic]),
    [['Samir', false, 'MUTED'], ['Sahil', true, 'UNMUTED'], ['Sheev', false, 'MUTED']]);
});

test('Meet-selected microphone becomes unavailable: owner fails closed, no other mic chosen', () => {
  const w = new World();
  const a = w.add('sahil', { join: true, mode: 'toggle' });
  settle(w);
  a.session.onDevice({ label: 'USB Microphone', available: true, readyState: 'live' });
  w.tap('sahil'); w.run(300);
  assert.equal(a.meet.state, 'UNMUTED');
  const commandsBefore = a.meet.commands;
  a.session.onDevice({ label: 'USB Microphone', available: false, readyState: 'ended' });
  w.run(300);
  assert.equal(a.meet.state, 'MUTED');
  assert.equal(a.session.ownership.record.owner, null);
  assert.match(a.session.snapshot().warning, /USB Microphone/);
  assert.equal(a.meet.commands - commandsBefore, 1, 'only a Meet mute command; nothing selects a device');
});

test('"Not now" then an explicit opt-in later: the device becomes visible again', () => {
  const w = new World();
  w.add('sahil', { join: true });
  const b = w.add('samir');
  settle(w);
  b.session.decline();
  w.run(1000);
  assert.equal(w.nodes.sahil.session.snapshot().nearby.length, 0);
  assert.ok(b.session.join());
  w.run(2500);
  assert.deepEqual(w.nodes.sahil.session.snapshot().participants.map((p) => p.name), ['Sahil', 'Samir']);
  w.pttDown('samir'); w.run(300);
  assert.deepEqual(w.owners(), ['samir']);
});
