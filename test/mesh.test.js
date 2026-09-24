// WebRTC discovery mesh: master election, LAN-only reachability, full-mesh
// convergence, master loss, merges and server outages. Fake WebRTC + real
// rendezvous store logic, on an async-aware fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomMesh } from '../src/offscreen/mesh.js';
import { RendezvousStore } from '../rendezvous/store.mjs';
import { CONFIG } from '../src/shared/config.js';
import { rng } from './sim.js';

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

/** Fake WebRTC: a link opens only if both ends are on the same network. */
class FakeRtc {
  constructor(clock) { this.clock = clock; this.registry = new Map(); this.pid = 1; }
  factory(node) {
    return (handlers) => {
      const rtc = this;
      const p = {
        node, handlers, pid: 0, remote: null, closed: false, isOpen: false,
        async createOffer() { p.pid = rtc.pid++; rtc.registry.set(p.pid, p); return JSON.stringify({ pid: p.pid, net: node.net }); },
        async acceptOffer(sdp) {
          const o = JSON.parse(sdp);
          p.pid = rtc.pid++; rtc.registry.set(p.pid, p);
          p.offerPid = o.pid;
          return JSON.stringify({ pid: p.pid, net: node.net });
        },
        async acceptAnswer(sdp) {
          const a = JSON.parse(sdp);
          const other = rtc.registry.get(a.pid);
          if (!other || other.offerPid !== p.pid || other.node.net !== node.net || !node.alive || !other.node.alive) return; // ICE never succeeds
          rtc.clock.setTimeout(() => {
            if (p.closed || other.closed) return;
            p.remote = other; other.remote = p; p.isOpen = other.isOpen = true;
            p.handlers.onOpen(); other.handlers.onOpen();
          }, 30);
        },
        send(s) {
          if (!p.isOpen || p.closed || !p.remote) return false;
          const r = p.remote;
          rtc.clock.setTimeout(() => { if (!r.closed) r.handlers.onMessage(s); }, 5);
          return true;
        },
        close() {
          if (p.closed) return;
          p.closed = true; p.isOpen = false;
          rtc.registry.delete(p.pid);
          const r = p.remote;
          if (r && !r.closed) rtc.clock.setTimeout(() => r.close(), 5); // data channel close propagates
          p.handlers.onClose();
        },
        /** Crash: the other side only notices when ICE consent fails. */
        vanish() {
          if (p.closed) return;
          p.closed = true;
          const r = p.remote;
          if (r && !r.closed) rtc.clock.setTimeout(() => r.close(), 3000);
        },
      };
      node.peers.add(p);
      return p;
    };
  }
}

class World {
  constructor() {
    this.clock = new AsyncClock();
    this.rtc = new FakeRtc(this.clock);
    this.store = new RendezvousStore({ now: this.clock.now, setTimeout: this.clock.setTimeout, clearTimeout: this.clock.clearTimeout });
    this.serverDown = false;
    this.nodes = new Map();
    this.random = rng(7);
  }

  signal() {
    const w = this;
    const hop = async () => {
      await new Promise((r) => w.clock.setTimeout(r, 10));
      if (w.serverDown) throw new Error('offline');
    };
    return {
      async masters() { await hop(); return w.store.masters(TAG); },
      async register(id) { await hop(); return w.store.register(TAG, id); },
      async unregister(id) { await hop(); w.store.unregister(TAG, id); },
      async post(to, from, data) { await hop(); w.store.post(TAG, to, from, data); },
      async take(id, waitS, abortSignal) { await hop(); return w.store.take(TAG, id, waitS * 1000, abortSignal); },
    };
  }

  add(name, { net = 'office', id, alias, claim } = {}) {
    const node = { name, net, alive: true, peers: new Set(), received: [], statuses: [] };
    node.id = id || [...name].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(16, '0').slice(0, 16);
    node.mesh = new RoomMesh({
      selfId: node.id, clock: this.clock, signal: alias ? this.aliasSignal(node, claim) : this.signal(), alias: alias || null, config: CONFIG,
      seal: async (o) => JSON.stringify({ s: o }), open: async (env) => env.s || null,
      createPeer: this.rtc.factory(node),
      onData: (d) => node.received.push(d),
      onStatus: (s) => node.statuses.push(s),
      random: this.random,
    });
    this.nodes.set(name, node);
    node.mesh.start();
    return node;
  }

  /** Deterministic master slot (PeerJS-cloud style): one claimable alias id. */
  aliasSignal(node, claim = { taken: false, holder: null }) {
    const w = this;
    const hop = async () => {
      await new Promise((r) => w.clock.setTimeout(r, 10));
      if (w.serverDown) throw new Error('offline');
    };
    return {
      async masters() { await hop(); return [node.mesh.alias]; },
      async register() {
        await hop();
        if (claim.taken && claim.holder !== node.id) throw new Error('id-taken: another device is the master');
        claim.taken = true; claim.holder = node.id;
        return [];
      },
      async unregister() { await hop(); if (claim.holder === node.id) { claim.taken = false; claim.holder = null; } },
      async post(to, _from, data) {
        await hop();
        const label = claim.holder === node.id ? node.mesh.alias : node.id; // holder speaks as the slot
        const target = [...w.nodes.values()].find((n) => n.id === to || n.mesh?.alias === to);
        target?.mesh._onSealedSignal(label, data, 'server');
      },
      async take() { await hop(); return []; },
    };
  }

  crash(name) {
    const n = this.nodes.get(name);
    n.alive = false;
    n.mesh.running = false; // no clean shutdown, no unregister
    for (const k of Object.keys(n.mesh.timers)) n.mesh._clear(k);
    for (const p of n.peers) p.vanish();
  }

  linked(a, b) { const l = this.nodes.get(a).mesh.links.get(this.nodes.get(b).id); return !!l?.open; }
  masters() { return this.store.masters(TAG).map((id) => [...this.nodes.values()].find((n) => n.id === id)?.name).sort(); }

  assertFullMesh(names) {
    for (const a of names) for (const b of names) if (a !== b) assert.ok(this.linked(a, b), `${a} <-> ${b} linked`);
  }
}

test('first device becomes the master; the next one listens, finds it and joins as member', async () => {
  const w = new World();
  const a = w.add('alice');
  await w.clock.run(2000);
  assert.equal(a.mesh.role, 'master');
  assert.equal(a.mesh.status().state, 'up', 'alone but discoverable = up');
  assert.deepEqual(w.masters(), ['alice']);

  const b = w.add('bob');
  await w.clock.run(3000);
  assert.equal(b.mesh.role, 'member');
  assert.equal(b.mesh.status().state, 'up');
  w.assertFullMesh(['alice', 'bob']);
  assert.deepEqual(w.masters(), ['alice'], 'still one registration on the server');

  a.mesh.broadcast('hello-from-alice');
  b.mesh.broadcast('hello-from-bob');
  await w.clock.run(100);
  assert.deepEqual(b.received, ['hello-from-alice']);
  assert.deepEqual(a.received, ['hello-from-bob']);
});

test('staggered joins build a full mesh with one master; members stay off the server', async () => {
  const w = new World();
  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
  for (const n of names) { w.add(n); await w.clock.run(1500); }
  await w.clock.run(12000);
  w.assertFullMesh(names);
  assert.deepEqual(w.masters(), ['alice']);
  // Once linked to a master, members do not poll the server at all.
  const before = w.store.rooms.get(TAG).inboxes.size;
  await w.clock.run(60000);
  w.assertFullMesh(names);
  assert.deepEqual(w.masters(), ['alice']);
  assert.ok(w.store.rooms.get(TAG).inboxes.size <= before + 1);
});

test('simultaneous joins converge to a single master and a full mesh', async () => {
  const w = new World();
  const names = ['alice', 'bob', 'carol', 'dave'];
  for (const n of names) w.add(n);
  await w.clock.run(40000);
  w.assertFullMesh(names);
  assert.equal(w.masters().length, 1, `one master, got ${w.masters()}`);
  const masterName = w.masters()[0];
  assert.equal([...w.nodes.values()].filter((n) => n.mesh.role === 'master').length, 1);
  assert.ok(masterName);
});

test('a participant on another network never links; each LAN gets its own master', async () => {
  const w = new World();
  w.add('remote', { net: 'home' });        // same meeting, different network, joins first
  await w.clock.run(2000);
  w.add('alice', { net: 'office' });
  await w.clock.run(12000);
  w.add('bob', { net: 'office' });
  await w.clock.run(12000);
  w.assertFullMesh(['alice', 'bob']);
  assert.ok(!w.linked('alice', 'remote') && !w.linked('bob', 'remote'), 'remote is not "nearby"');
  assert.deepEqual(w.masters(), ['alice', 'remote']);
  assert.equal(w.nodes.get('bob').mesh.role, 'member');
  // Keeps working long-term with only periodic (backed-off) merge probes.
  await w.clock.run(120000);
  w.assertFullMesh(['alice', 'bob']);
  assert.ok(!w.linked('alice', 'remote'));
  assert.deepEqual(w.masters(), ['alice', 'remote']);
});

test('master leaves cleanly: lowest remaining member takes over; newcomers still find the room', async () => {
  const w = new World();
  for (const n of ['alice', 'bob', 'carol']) { w.add(n); await w.clock.run(3000); }
  await w.clock.run(8000);
  w.nodes.get('alice').mesh.stop();
  await w.clock.run(3000);
  assert.deepEqual(w.masters(), ['bob']);
  assert.ok(w.linked('bob', 'carol'));
  w.add('dave');
  await w.clock.run(15000);
  w.assertFullMesh(['bob', 'carol', 'dave']);
  assert.deepEqual(w.masters(), ['bob']);
});

test('master crashes (stale registration): cluster recovers, a newcomer ends up in the same mesh', async () => {
  const w = new World();
  for (const n of ['alice', 'bob', 'carol']) { w.add(n); await w.clock.run(3000); }
  await w.clock.run(8000);
  w.crash('alice');
  await w.clock.run(1000);
  w.add('dave'); // server still lists the dead master for up to 30 s
  await w.clock.run(60000);
  w.assertFullMesh(['bob', 'carol', 'dave']);
  assert.deepEqual(w.masters(), ['bob']);
});

test('discovery server down: unavailable (=> local only) until it comes back', async () => {
  const w = new World();
  w.serverDown = true;
  const a = w.add('alice');
  await w.clock.run(3000);
  assert.equal(a.mesh.status().state, 'unavailable');
  assert.match(a.mesh.status().error, /unreachable/);
  w.serverDown = false;
  await w.clock.run(8000);
  assert.equal(a.mesh.status().state, 'up');
  assert.equal(a.mesh.role, 'master');
});

test('server outage after the mesh formed: LAN links keep working', async () => {
  const w = new World();
  for (const n of ['alice', 'bob', 'carol']) { w.add(n); await w.clock.run(3000); }
  await w.clock.run(8000);
  w.serverDown = true;
  await w.clock.run(60000);
  w.assertFullMesh(['alice', 'bob', 'carol']);
  for (const n of w.nodes.values()) assert.equal(n.mesh.status().state, 'up');
  w.nodes.get('carol').mesh.broadcast('still-here');
  await w.clock.run(100);
  assert.deepEqual(w.nodes.get('alice').received, ['still-here']);
});

test('forged / replayed / misaddressed signalling is ignored', async () => {
  const w = new World();
  const a = w.add('alice');
  await w.clock.run(2000);
  const links = () => a.mesh.links.size;
  const eve = 'eeeeeeeeeeeeeeee';
  const sdp = JSON.stringify({ pid: 999, net: 'office' });
  const post = (payload) => w.store.post(TAG, a.id, eve, JSON.stringify({ s: payload }));
  post({ t: 'offer', sdp, from: 'ffffffffffffffff', to: a.id, ts: w.clock.wallNow() });   // from mismatch
  post({ t: 'offer', sdp, from: eve, to: 'dddddddddddddddd', ts: w.clock.wallNow() });   // not for us
  post({ t: 'offer', sdp, from: eve, to: a.id, ts: w.clock.wallNow() - 10 * 60000 });     // replay
  w.store.post(TAG, a.id, eve, 'not json');
  await w.clock.run(500);
  assert.equal(links(), 0);
});

test('forced race: everyone registers as master at once, then masters merge down to one', async () => {
  const w = new World();
  w.random = () => 0; // no start jitter: all devices discover at exactly the same moment
  const names = ['alice', 'bob', 'carol', 'dave'];
  for (const n of names) w.add(n);
  await w.clock.run(500);
  assert.equal(w.masters().length, 4, 'all raced into the master role');
  await w.clock.run(30000);
  assert.deepEqual(w.masters(), ['alice'], 'lowest id survives the merge');
  w.assertFullMesh(names);
});

test('no glare waste: a staggered 6-device room creates ~2 peer objects per link', async () => {
  const w = new World();
  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
  for (const n of names) { w.add(n); await w.clock.run(1500); }
  await w.clock.run(60000);
  w.assertFullMesh(names);
  const created = [...w.nodes.values()].reduce((s, n) => s + n.peers.size, 0);
  const links = (names.length * (names.length - 1)) / 2;
  assert.ok(created <= links * 2 + 2, `created ${created} peer objects for ${links} links`);
});

test('built-in cloud: deterministic master slot — first claim wins, loser links the slot as member', async () => {
  const w = new World();
  const claim = { taken: false, holder: null };
  const a = w.add('alice', { alias: TAG, claim });
  await w.clock.run(8000);
  assert.equal(a.mesh.role, 'master', 'first device claims the slot');

  const b = w.add('bob', { alias: TAG, claim });
  await w.clock.run(30000);
  assert.equal(a.mesh.role, 'master', 'holder keeps the slot');
  assert.equal(b.mesh.role, 'member', 'loser of the claim is a member');
  assert.ok(w.linked('alice', 'bob'), 'bob linked the master through its alias');
  assert.equal(w.nodes.get('bob').received.length, 0, 'no data flowed yet');

  // and a third member converges through gossip as usual
  const c = w.add('carol', { alias: TAG, claim });
  await w.clock.run(30000);
  assert.ok(w.linked('alice', 'carol'), 'carol linked the master');
  assert.ok(w.linked('bob', 'carol'), 'full mesh formed');
});
