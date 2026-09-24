// Deterministic simulator: fake clock, fake LAN (latency / loss / partitions) and
// a fake Google Meet mic button. Runs the real RoomSession code.

import { CONFIG } from '../src/shared/config.js';
import { RoomSession, TRANSPORT } from '../src/background/session.js';
import { StateMachine } from '../src/shared/fsm.js';

StateMachine.strict = true; // any illegal state transition throws

export class FakeClock {
  constructor() {
    this.t = 10_000;
    this.wallBase = 1_750_000_000_000;
    this.timers = new Map();
    this.nextId = 1;
    this.now = () => this.t;
    this.wallNow = () => this.wallBase + this.t;
    this.setTimeout = (fn, ms) => {
      const id = this.nextId++;
      this.timers.set(id, { at: this.t + Math.max(0, ms || 0), fn, id });
      return id;
    };
    this.clearTimeout = (id) => { this.timers.delete(id); };
  }

  advance(ms, onStep) {
    const end = this.t + ms;
    for (;;) {
      let next = null;
      for (const tm of this.timers.values()) {
        if (!next || tm.at < next.at || (tm.at === next.at && tm.id < next.id)) next = tm;
      }
      if (!next || next.at > end) break;
      this.t = Math.max(this.t, next.at);
      this.timers.delete(next.id);
      next.fn();
      onStep?.();
    }
    this.t = end;
    onStep?.();
  }

  /** Laptop sleep: time jumps, nothing ran in between. */
  sleep(ms) { this.t += ms; }
}

/** Seeded PRNG so lossy tests are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimNet {
  constructor(clock, { latency = 5, jitter = 0, loss = 0, seed = 1 } = {}) {
    this.clock = clock;
    this.latency = latency;
    this.jitter = jitter;
    this.loss = loss;
    this.rand = rng(seed);
    this.nodes = new Map();
    this.blocked = new Set();
    this.sent = [];
  }
  add(name, node) { this.nodes.set(name, node); }
  send(from, msg) {
    const wire = JSON.stringify(msg);
    this.sent.push(JSON.parse(wire));
    const src = this.nodes.get(from);
    if (!src || !src.online) return;
    for (const [name, node] of this.nodes) {
      if (name === from) continue;
      if (this.blocked.has(`${from}>${name}`)) continue;
      if (this.rand() < this.loss) continue;
      const delay = this.latency + this.rand() * this.jitter;
      this.clock.setTimeout(() => {
        if (!node.online || !src.online || node.session.disposed) return;
        if (this.blocked.has(`${from}>${name}`)) return;
        node.session.receive(JSON.parse(wire));
      }, delay);
    }
  }
  partition(a, b) { this.blocked.add(`${a}>${b}`); this.blocked.add(`${b}>${a}`); }
  isolate(a) { for (const n of this.nodes.keys()) if (n !== a) this.partition(a, n); }
  healAll() { this.blocked.clear(); }
}

export class FakeMeet {
  constructor(clock, { clickDelay = 20 } = {}) {
    this.clock = clock;
    this.clickDelay = clickDelay;
    this.state = 'MUTED';
    this.session = null;
    this.broken = false;   // clicks do nothing
    this.commands = 0;
  }
  command({ id, muted }) {
    this.commands++;
    const target = muted ? 'MUTED' : 'UNMUTED';
    if (this.state === target) {
      this.clock.setTimeout(() => this.session.onMicCommandResult({ id, ok: true, mic: this.state }), 1);
      return;
    }
    if (this.broken) {
      this.clock.setTimeout(() => this.session.onMicCommandResult({ id, ok: false, mic: this.state }), this.clickDelay);
      return;
    }
    this.clock.setTimeout(() => {
      this.state = target; // the page still applies the click even if the session ended
      if (this.session.disposed) return;
      this.session.onMeetState(target, 'command');
      this.session.onMicCommandResult({ id, ok: true, mic: target });
    }, this.clickDelay);
  }
  manual(target) {
    this.state = target;
    this.session.onMeetState(target, 'external');
  }
}

export const IDS = {
  sahil: 'a000000000000001',
  samir: 'b000000000000002',
  sheev: 'c000000000000003',
  dana: 'd000000000000004',
};

export class World {
  constructor({ config = {}, net = {} } = {}) {
    this.clock = new FakeClock();
    this.config = { ...CONFIG, ...config };
    this.net = new SimNet(this.clock, net);
    this.nodes = {};
    this.violations = [];
    this.maxUnmuted = 0;
  }

  add(name, { mode = 'ptt', transport = TRANSPORT.UP, join = false, id = IDS[name], clickDelay } = {}) {
    const meet = new FakeMeet(this.clock, { clickDelay });
    const node = { name, meet, online: true, session: null };
    node.session = new RoomSession({
      clock: this.clock, wallNow: this.clock.wallNow, config: this.config,
      meetingId: 'abc-defg-hij', displayName: name[0].toUpperCase() + name.slice(1), mode,
      transportState: transport,
      send: (m) => this.net.send(name, m),
      sendMeetCommand: (c) => meet.command(c),
      idFactory: (() => { let n = 0; return () => (n++ === 0 ? id : id.slice(0, 12) + (0x1000 + n).toString(16).slice(-4)); })(),
    });
    meet.session = node.session;
    this.net.add(name, node);
    this.nodes[name] = node;
    node.session.start('MUTED');
    if (join) node.session.join();
    return node;
  }

  /** Advance time, checking the core invariant after every event. */
  run(ms) {
    this.clock.advance(ms, () => this.check());
  }

  check() {
    const unmuted = Object.values(this.nodes)
      .filter((n) => !n.session.disposed && n.session.consent.joined && n.meet.state === 'UNMUTED');
    this.maxUnmuted = Math.max(this.maxUnmuted, unmuted.length);
    if (unmuted.length > 1) this.violations.push({ t: this.clock.t, who: unmuted.map((n) => n.name) });
  }

  owners() {
    return Object.values(this.nodes)
      .filter((n) => !n.session.disposed && n.session.ownership.state === 'OWNER')
      .map((n) => n.name);
  }

  pttDown(name) { this.nodes[name].session.onKey('down', false); }
  pttUp(name) { this.nodes[name].session.onKey('up'); }
  /** A physical toggle key press (keydown + keyup). */
  tap(name) { this.nodes[name].session.onKey('down', false); this.nodes[name].session.onKey('up'); }
  rec(name) { return this.nodes[name].session.ownership.record; }
}
