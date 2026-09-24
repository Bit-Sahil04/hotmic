// Discovery / presence: tracks the other extension instances heard in this room
// (the room is already scoped to one meeting by crypto.js - devices from other
// meetings can neither be decrypted nor even matched by room tag).

export class PeerTable {
  constructor({ selfId, config }) {
    this.selfId = selfId;
    this.config = config;
    /** @type {Map<string, Peer>} */
    this.peers = new Map();
    this.leftIds = new Set();
  }

  /**
   * Applies a validated heartbeat. Returns null for duplicates/stale/self.
   * @returns {{peer: Peer, isNew: boolean, changed: boolean} | null}
   */
  upsert(msg, now) {
    if (msg.d === this.selfId) return null;
    if (this.leftIds.has(msg.d)) return null; // departed incarnations never come back
    let peer = this.peers.get(msg.d);
    if (peer && msg.s <= peer.lastSeq) return null; // duplicate / reordered / replay
    const isNew = !peer || !this.isLive(peer, now);
    if (!peer) {
      peer = {
        id: msg.d, firstSeen: now, lastSeq: -1, lastHeard: now, name: msg.n,
        status: msg.st, mic: msg.m, synced: msg.syn, rec: null, heldMs: 0,
        wantSince: null, acks: {}, unmutedSince: null,
      };
      this.peers.set(msg.d, peer);
    } else if (!this.isLive(peer, now)) {
      // came back after a timeout: treat as freshly seen for lease exemptions
      peer.firstSeen = now;
    }
    const prevSig = sig(peer);
    peer.lastSeq = msg.s;
    peer.lastHeard = now;
    peer.name = msg.n;
    peer.status = msg.st;
    if (msg.m !== 'UNMUTED') peer.unmutedSince = null;
    else if (peer.mic !== 'UNMUTED' || peer.unmutedSince === null) peer.unmutedSince = now;
    peer.mic = msg.m;
    peer.synced = msg.syn;
    peer.rec = { epoch: msg.r.e, owner: msg.r.o };
    peer.heldMs = msg.r.h;
    if (msg.w === null) peer.wantSince = null;
    else if (peer.wantSince === null) peer.wantSince = now - msg.w;
    peer.acks = msg.a;
    return { peer, isNew, changed: isNew || prevSig !== sig(peer) };
  }

  /** Graceful leave. Returns the removed peer, if any. */
  markLeft(msg) {
    const peer = this.peers.get(msg.d);
    if (peer && msg.s <= peer.lastSeq) return null;
    this.peers.delete(msg.d);
    this.leftIds.add(msg.d);
    return peer || null;
  }

  get(id) { return this.peers.get(id); }
  isLive(peer, now) { return now - peer.lastHeard <= this.config.PEER_TIMEOUT_MS; }
  live(now) { return [...this.peers.values()].filter((p) => this.isLive(p, now)); }
  liveJoined(now) { return this.live(now).filter((p) => p.status === 'joined'); }

  /** Acks to piggy-back on our heartbeat: last seq heard from each live peer. */
  ackMap(now) {
    const a = {};
    for (const p of this.live(now)) a[p.id] = p.lastSeq;
    return a;
  }

  prune(now) {
    let removed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastHeard > this.config.PEER_FORGET_MS) { this.peers.delete(id); removed = true; }
    }
    return removed;
  }

  /** Drops all presence (e.g. after sleep); seq high-water marks are kept. */
  expireAll() {
    for (const p of this.peers.values()) p.lastHeard = -Infinity;
  }
}

function sig(p) {
  return `${p.status}|${p.mic}|${p.name}|${p.rec?.epoch}|${p.rec?.owner}|${p.wantSince === null}|${p.synced}`;
}

/**
 * @typedef {object} Peer
 * @property {string} id
 * @property {string} name
 * @property {'available'|'joined'} status
 * @property {'MUTED'|'UNMUTED'|'UNKNOWN'} mic
 * @property {boolean} synced
 * @property {{epoch:number, owner:string|null}|null} rec
 * @property {number} heldMs
 * @property {number|null} wantSince
 * @property {Record<string, number>} acks
 * @property {number} firstSeen
 * @property {number} lastHeard
 * @property {number} lastSeq
 * @property {number|null} unmutedSince
 */
