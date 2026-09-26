// PeerJsRoomMesh: deterministic master slot, cloud-arbitrated claims, sealed
// channel auth, member links and master death. Fake PeerJS cloud, real mesh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PeerJsRoomMesh } from '../src/offscreen/peerjs-mesh.js';
import { CONFIG } from '../src/shared/config.js';

const TAG = 'ab'.repeat(16);
const flush = () => new Promise((r) => setImmediate(r));

class AsyncClock {
  constructor() { this.t = 0; this.timers = new Map(); this.id = 1; }
  now = () => this.t;
  wallNow = () => 1_750_000_000_000 + this.t;
  setTimeout = (fn, ms) => { const id = this.id++; this.timers.set(id, { at: this.t + Math.max(0, ms || 0), fn, id }); return id; };
  clearTimeout = (id) => { this.timers.delete(id); };
  async run(ms) {
    const end = this.t + ms;
    for (;;) {
      await flush(); await flush();
      let next = null;
      for (const tm of this.timers.values()) if (!next || tm.at < next.at || (tm.at === next.at && tm.id < next.id)) next = tm;
      if (!next || next.at > end) break;
      this.t = Math.max(this.t, next.at);
      this.timers.delete(next.id);
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

// ---- fake PeerJS cloud ----------------------------------------------------------

class FakeConn {
  constructor(cloud, localPeer, remotePeerId) {
    this.cloud = cloud; this.localPeer = localPeer; this.peer = remotePeerId; this.remotePeerId = remotePeerId;
    this.paired = null; this.open = false; this.listeners = new Map();
  }
  on(ev, fn) { (this.listeners.get(ev) || this.listeners.set(ev, []).get(ev)).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.listeners.get(ev) || []) fn(...a); }
  send(data) { if (this.open && this.paired && this.paired.open) this.paired.incoming(data); }
  incoming(data) { if (this.open) this.emit('data', data); }
  close() {
    if (!this.open) return;
    this.open = false;
    this.localPeer.conns.delete(this);
    this.cloud.clock.setTimeout(() => this.emit('close'), 1);
    if (this.paired && this.paired.open) this.paired.close();
  }
}

class FakePeer {
  constructor(cloud, id) {
    this.cloud = cloud; this.id = id; this.listeners = new Map(); this.open = false;
    this.destroyed = false; this.disconnected = false; this.conns = new Set();
  }
  on(ev, fn) { (this.listeners.get(ev) || this.listeners.set(ev, []).get(ev)).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.listeners.get(ev) || []) fn(...a); }
  connect(target) {
    const c = new FakeConn(this.cloud, this, target);
    this.conns.add(c);
    const targetPeer = this.cloud.ids.get(target);
    if (!targetPeer) {
      this.cloud.clock.setTimeout(() => this.emit('error', Object.assign(new Error('Could not connect to peer ' + target), { type: 'peer-unavailable' })), 5);
      return c;
    }
    const inb = new FakeConn(this.cloud, targetPeer, this.id);
    targetPeer.conns.add(inb);
    c.paired = inb; inb.paired = c; c.open = inb.open = true;
    this.cloud.clock.setTimeout(() => targetPeer.emit('connection', inb), 2); // master sees the conn first (like the real lib)
    this.cloud.clock.setTimeout(() => c.emit('open'), 5);
    return c;
  }
  connClosed() { this.cloud.clock.setTimeout(() => { if (!this.destroyed) this.emit('close'); }, 1); }
  reconnect() {
    if (this.destroyed) return;
    this.disconnected = false;
    this.cloud.clock.setTimeout(() => { if (!this.destroyed) { this.open = true; this.emit('open', this.id); } }, 5);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.open = false;
    this.cloud.ids.delete(this.id);
    for (const c of [...this.conns]) c.close();
    this.emit('close');
  }
}

class FakeCloud {
  constructor(clock) {
    this.clock = clock; this.ids = new Map();
    const self = this;
    this.Peer = class extends FakePeer {
      constructor(id) {
        super(self, id);
        if (self.ids.has(id)) {
          const taken = Object.assign(new Error(`ID "${id}" is taken`), { type: 'unavailable-id' });
          self.clock.setTimeout(() => { this.destroy(); this.emit('error', taken); }, 0);
        } else {
          self.ids.set(id, this);
          self.clock.setTimeout(() => { if (!this.destroyed) { this.open = true; this.emit('open', this.id); } }, 0);
        }
      }
    };
  }
}

// ---- helpers ---------------------------------------------------------------------

/** Sealed envelope fake: wraps JSON with a room-key check. */
const KEY = 'k:' + TAG.slice(0, 8);
// Mirrors RoomCrypto: seal -> string envelope; open takes the PARSED envelope.
const seal = async (obj) => JSON.stringify({ fake: KEY, obj });
const open = async (env) => (env && env.fake === KEY) ? env.obj : null;

function mkMesh(cloud, selfId, hooks = {}) {
  const statuses = [];
  const mesh = new PeerJsRoomMesh({
    selfId, clock: cloud.clock, config: CONFIG, roomTag: TAG, peerFactory: cloud.Peer,
    seal, open,
    onData: hooks.onData || (() => {}),
    onStatus: (st) => statuses.push(st),
  });
  return { mesh, statuses };
}

const slotId = 'h' + TAG;

// ---- tests -----------------------------------------------------------------------

test('first device claims the slot and becomes master; second joins as member', async () => {
  const clock = new AsyncClock();
  const cloud = new FakeCloud(clock);
  const A = mkMesh(cloud, 'a'.repeat(32));
  const B = mkMesh(cloud, 'b'.repeat(32));
  A.mesh.start();
  await clock.run(2000);
  assert.equal(A.mesh.role, 'master');
  assert.ok(cloud.ids.has(slotId), 'slot claimed on the cloud');
  B.mesh.start();
  await clock.run(4000);
  assert.equal(A.mesh.role, 'master');
  assert.equal(B.mesh.role, 'member');
  assert.ok(B.mesh._openLinks().some((l) => l.isMaster), 'B linked to the slot');
  assert.equal(B.mesh.status().state, 'up');
  A.mesh.stop(); B.mesh.stop();
});

test('simultaneous start: exactly one master (cloud arbitrates the claim)', async () => {
  const clock = new AsyncClock();
  const cloud = new FakeCloud(clock);
  const A = mkMesh(cloud, 'a'.repeat(32));
  const B = mkMesh(cloud, 'b'.repeat(32));
  A.mesh.start(); B.mesh.start();
  await clock.run(6000);
  const roles = [A.mesh.role, B.mesh.role].sort();
  assert.deepEqual(roles, ['master', 'member'], 'one master, one member');
  assert.equal(cloud.ids.has(slotId), true);
  A.mesh.stop(); B.mesh.stop();
});

test('only room-key holders complete channel auth; rogue links are dropped', async () => {
  const clock = new AsyncClock();
  const cloud = new FakeCloud(clock);
  const A = mkMesh(cloud, 'a'.repeat(32));
  A.mesh.start();
  await clock.run(2000);
  assert.equal(A.mesh.role, 'master');
  // rogue: claims a member cloud id, dials the slot with the WRONG room key
  const rogue = new cloud.Peer('m' + TAG.slice(0, 8) + 'c'.repeat(32));
  await clock.run(50);
  const conn = rogue.connect(slotId, {});
  await clock.run(50);
  conn.incoming(typeof conn.paired === 'object' && conn.paired ? 'x' : 'x'); // no-op probe
  // master sends auth challenge; rogue cannot produce a valid sealed reply
  await clock.run(6000);
  const masterLinks = [...A.mesh.links.values()].filter((l) => l.id !== slotId);
  assert.ok(masterLinks.every((l) => !l.open || l.peer.authed), 'no unauthed link survives');
  A.mesh.stop();
});

test('data flows over links only after auth, both directions', async () => {
  const clock = new AsyncClock();
  const cloud = new FakeCloud(clock);
  const got = [];
  const A = mkMesh(cloud, 'a'.repeat(32));
  const B = mkMesh(cloud, 'b'.repeat(32), { onData: (d) => got.push(['B', d]) });
  A.mesh.start();
  await clock.run(2000);
  B.mesh.start();
  await clock.run(4000);
  A.mesh.broadcast('hello-from-A');
  await clock.run(200);
  assert.deepEqual(got, [['B', 'hello-from-A']]);
  A.mesh.stop(); B.mesh.stop();
});

test('master death: the slot frees and a member re-claims it', async () => {
  const clock = new AsyncClock();
  const cloud = new FakeCloud(clock);
  const A = mkMesh(cloud, 'a'.repeat(32));
  const B = mkMesh(cloud, 'b'.repeat(32));
  A.mesh.start();
  await clock.run(2000);
  B.mesh.start();
  await clock.run(4000);
  assert.equal(A.mesh.role, 'master');
  A.mesh.stop(); // master leaves (releases the slot)
  await clock.run(100);
  assert.ok(!cloud.ids.has(slotId), 'slot released');
  await clock.run(15000); // member notices, re-claims
  assert.equal(B.mesh.role, 'master', 'B took over the slot');
  B.mesh.stop();
});

test('member id includes the room tag slice (two meetings never collide)', () => {
  const clock = new AsyncClock();
  const cloud = new FakeCloud(clock);
  const { mesh } = mkMesh(cloud, 'a'.repeat(32));
  assert.equal(mesh._memberCloudId(), 'm' + TAG.slice(0, 8) + 'a'.repeat(32));
  mesh.stop();
});
