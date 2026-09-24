// Rendezvous store: the only state the discovery server keeps.
//
// Per room tag (an opaque PBKDF2 output; the server never learns the meeting code):
//   masters: a few device ids, each with a TTL (normally one master per LAN)
//   inboxes: short-lived queues of sealed signalling blobs (AES-GCM, opaque to us)
// Everything expires; nothing is persisted.

export const LIMITS = Object.freeze({
  MASTER_TTL_MS: 30000,
  MAX_MASTERS: 16,        // per room: ~one per distinct network with HotMic users
  MESSAGE_TTL_MS: 60000,
  MAX_QUEUE: 64,          // per inbox
  MAX_DATA: 16384,        // bytes per blob
  MAX_WAIT_MS: 25000,
  MAX_ROOMS: 10000,
});

const TAG = /^[a-f0-9]{32,64}$/;
const ID = /^[a-f0-9]{8,32}$/;
export const validTag = (t) => typeof t === 'string' && TAG.test(t);
export const validId = (i) => typeof i === 'string' && ID.test(i);

export class RendezvousStore {
  constructor({ now = () => Date.now(), setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout, limits = LIMITS } = {}) {
    this.now = now; this.st = st; this.ct = ct; this.limits = limits;
    this.rooms = new Map();
  }

  _room(tag, create) {
    let r = this.rooms.get(tag);
    if (!r && create) {
      if (this.rooms.size >= this.limits.MAX_ROOMS) this.sweep();
      if (this.rooms.size >= this.limits.MAX_ROOMS) throw Object.assign(new Error('server full'), { status: 503 });
      r = { masters: new Map(), inboxes: new Map() };
      this.rooms.set(tag, r);
    }
    return r;
  }

  masters(tag) {
    const r = this._room(tag, false);
    if (!r) return [];
    const now = this.now();
    for (const [id, exp] of r.masters) if (exp <= now) r.masters.delete(id);
    return [...r.masters.keys()];
  }

  register(tag, id) {
    const list = this.masters(tag);
    const r = this._room(tag, true);
    if (!r.masters.has(id) && list.length >= this.limits.MAX_MASTERS) {
      throw Object.assign(new Error('too many masters'), { status: 409 });
    }
    r.masters.set(id, this.now() + this.limits.MASTER_TTL_MS);
    return this.masters(tag);
  }

  unregister(tag, id) {
    this._room(tag, false)?.masters.delete(id);
  }

  _inbox(r, id) {
    let box = r.inboxes.get(id);
    if (!box) { box = { queue: [], waiters: new Set() }; r.inboxes.set(id, box); }
    return box;
  }

  post(tag, to, from, data) {
    if (typeof data !== 'string' || data.length > this.limits.MAX_DATA) throw Object.assign(new Error('bad data'), { status: 400 });
    const box = this._inbox(this._room(tag, true), to);
    const now = this.now();
    box.queue = box.queue.filter((m) => m.exp > now);
    if (box.queue.length >= this.limits.MAX_QUEUE) box.queue.shift();
    box.queue.push({ from, data, exp: now + this.limits.MESSAGE_TTL_MS });
    for (const w of box.waiters) w();
  }

  /** Resolves with pending messages as soon as there are any, or [] after waitMs. */
  take(tag, id, waitMs = 0, abortSignal = null) {
    const r = this._room(tag, true);
    const box = this._inbox(r, id);
    const drain = () => {
      const now = this.now();
      const out = box.queue.filter((m) => m.exp > now).map(({ from, data }) => ({ from, data }));
      box.queue = [];
      return out;
    };
    const ready = drain();
    const wait = Math.min(Math.max(0, waitMs), this.limits.MAX_WAIT_MS);
    if (ready.length || wait === 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        box.waiters.delete(waiter);
        this.ct(timer);
        abortSignal?.removeEventListener?.('abort', finish);
        resolve(drain());
      };
      const waiter = () => finish();
      box.waiters.add(waiter);
      timer = this.st(finish, wait);
      abortSignal?.addEventListener?.('abort', finish, { once: true });
    });
  }

  /** Drop expired masters/messages and empty rooms. */
  sweep() {
    const now = this.now();
    for (const [tag, r] of this.rooms) {
      for (const [id, exp] of r.masters) if (exp <= now) r.masters.delete(id);
      for (const [id, box] of r.inboxes) {
        box.queue = box.queue.filter((m) => m.exp > now);
        if (!box.queue.length && !box.waiters.size) r.inboxes.delete(id);
      }
      if (!r.masters.size && !r.inboxes.size) this.rooms.delete(tag);
    }
  }
}
