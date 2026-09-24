// Runs several LAN transports side by side (native UDP helper + WebRTC mesh).
// Sends on every transport that is up; delivers each received envelope once.
// Envelopes carry a random IV, so identical strings are the same message.

const DEDUPE_WINDOW = 2048;

export class MultiTransport {
  constructor(parts) {
    this.parts = parts;
    this.seen = new Set();
    this.order = [];
  }

  /** Aggregate for the sessions: any path up => up. */
  get state() {
    const s = this.parts.map((p) => p.state);
    if (s.includes('up')) return 'up';
    if (s.includes('connecting')) return 'connecting';
    if (s.includes('lost')) return 'lost';
    if (s.every((x) => x === 'idle')) return 'idle';
    return 'unavailable';
  }

  start() { for (const p of this.parts) p.start(); }
  stop() { for (const p of this.parts) p.stop(); }

  send(data) {
    this.accept(data); // don't deliver our own message back if a path echoes it
    let ok = false;
    for (const p of this.parts) if (p.state === 'up') ok = p.send(data) || ok;
    return ok;
  }

  /** true the first time an envelope is seen. */
  accept(data) {
    if (this.seen.has(data)) return false;
    this.seen.add(data);
    this.order.push(data);
    if (this.order.length > DEDUPE_WINDOW) this.seen.delete(this.order.shift());
    return true;
  }
}
