// PeerJS-cloud driver for RoomMesh — the "batteries included" provider.
//
// The room's master slot is the deterministic PeerJS id "h" + roomTag; the cloud
// arbitrates claims (second claim gets "unavailable-id"), so only ONE device can
// ever hold the slot — no split-brain masters. Members claim "m" + tag8 + selfId
// and dial the slot directly. Links are PeerJS DataConnections with LAN-only ICE
// (no STUN/TURN), so traffic still never leaves the local network; the cloud only
// relays opaque SDPs (mDNS candidates) and sees random ids.
//
// Authentication moved from the SDP layer to the channel layer: the first
// exchange on every link is a sealed challenge/response bound to the room key;
// links that fail it within the window are closed. Everything else (roles,
// gossip, relays, merges, step-down) is inherited from RoomMesh unchanged.

import { RoomMesh } from './mesh.js';

const ID = /^[a-f0-9]{8,32}$/;

export class PeerJsRoomMesh extends RoomMesh {
  /**
   * @param {object} o  RoomMesh options minus `signal`/`alias`, plus:
   * @param {string} o.roomTag   32-hex room tag (blinded slot id = "h" + tag)
   * @param {Function} o.peerFactory  the PeerJS Peer constructor (global Peer)
   */
  constructor(o) {
    super({ ...o, signal: undefined, alias: undefined });
    if (!o.roomTag || !ID.test(o.roomTag)) throw new Error('bad room tag');
    if (typeof o.peerFactory !== 'function') throw new Error('PeerJS library not loaded');
    this.roomTag = o.roomTag;
    this.slotId = 'h' + o.roomTag;
    this.tag8 = o.roomTag.slice(0, 8);
    this.Peer = o.peerFactory;

    this.memberPeer = null;   // our always-on cloud identity ("m" + tag8 + selfId)
    this.memberPeerReady = null;
    this.slotPeer = null;     // exists only while we hold the master slot
    this.slotReady = null;
    this.cloudBackoff = 0;
    this.probing = false;
    this.createPeer = (handlers) => this._deferredPeer(handlers);
    // Small debug ring for the offscreen document (read via DevTools).
    this._dbg = (m) => {
      try {
        const L = (globalThis.__hotmicMeshLogs = globalThis.__hotmicMeshLogs || []);
        L.push(Math.round(this.clock.now()) + ' ' + m);
        if (L.length > 60) L.shift();
      } catch { /* ignore */ }
    };
  }

  // ---- cloud identities -------------------------------------------------------

  _memberCloudId() { return 'm' + this.tag8 + this.selfId; }

  _ensureMemberPeer() {
    if (this.memberPeerReady) return this.memberPeerReady;
    const peer = new this.Peer(this._memberCloudId(), { debug: 0, config: { iceServers: [] } });
    this.memberPeer = peer;
    this.memberPeerReady = new Promise((resolve) => {
      peer.on('open', () => { this._dbg('member peer open'); resolve(true); });
      peer.on('error', (err) => {
        const type = err && err.type;
        if (type === 'unavailable-id') {
          // Our own id is taken (e.g. a stale twin from a killed document):
          // rotate the identity and retry.
          this._dbg('member id taken -> rotate');
          this._rotateMemberPeer();
          resolve(false);
        } else if (type !== 'peer-unavailable') { // routine dial misses are handled per-probe
          if (this.running) this._cloudDown(type);
          if (peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { /* handled by retry */ } }
        }
      });
      peer.on('disconnected', () => {
        if (this.running) { this._dbg('member disconnected -> reconnect'); try { peer.reconnect(); } catch { /* ignore */ } }
      });
    });
    return this.memberPeerReady;
  }

  _rotateMemberPeer() {
    this.memberPeerReady = null;
    try { this.memberPeer?.destroy(); } catch { /* ignore */ }
    this.memberPeer = null;
    this._ensureMemberPeer();
  }

  _ensureSlotPeer() {
    // Returns true when WE hold the slot. Throws {idTaken:true} when someone
    // else holds it (the cloud arbitrates claims — no split-brain possible).
    if (this.slotPeer && this.slotPeer.open) return true;
    const claim = async () => {
      const peer = new this.Peer(this.slotId, { debug: 0, config: { iceServers: [] } });
      this.slotPeer = peer;
      this.slotReady = new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(Object.assign(new Error('slot timeout'), { retry: true })), 5000);
        peer.on('open', () => { clearTimeout(to); this._dbg('slot peer open'); resolve(true); });
        peer.on('error', (err) => {
          clearTimeout(to);
          if (err && err.type === 'unavailable-id') reject(Object.assign(new Error('id-taken'), { idTaken: true }));
          else reject(Object.assign(new Error('slot ' + (err && err.type)), { retry: true }));
        });
        peer.on('disconnected', () => {
          // Cloud socket dropped but the id is still ours: reconnect keeps it.
          if (this.running && !peer.destroyed) { this._dbg('slot disconnected -> reconnect'); try { peer.reconnect(); } catch { /* ignore */ } }
        });
      });
      try { await this.slotReady; } catch (err) {
        try { peer.destroy(); } catch { /* ignore */ }
        if (this.slotPeer === peer) this.slotPeer = null;
        throw err;
      }
      peer.on('connection', (conn) => this._onInboundConn(conn));
      return true;
    };
    return claim();
  }

  // ---- link plumbing ------------------------------------------------------------

  _deferredPeer(handlers) {
    const adapter = {
      conn: null, authed: false, authChain: null, handlers,
      createOffer: () => Promise.reject(new Error('sdp unused on cloud links')),
      acceptOffer: () => Promise.reject(new Error('sdp unused on cloud links')),
      acceptAnswer: () => Promise.reject(new Error('sdp unused on cloud links')),
      send: (s) => {
        if (!adapter.conn || !adapter.authed) return false;
        try { adapter.conn.send(s); return true; } catch { return false; }
      },
      close: () => { try { adapter.conn?.close(); } catch { /* ignore */ } },
    };
    return adapter;
  }

  _bindConn(link, conn, initiator) {
    link.peer.conn = conn;
    const authTimer = this.clock.setTimeout(() => {
      if (!link.peer.authed && this.links.get(link.id) === link) this._fail(link);
    }, this.cfg.RTC_CONNECT_TIMEOUT_MS);

    if (initiator) {
      conn.on('open', () => {
        if (!link.peer.authed && this.links.get(link.id) === link) this._startAuth(link, conn, true);
      });
    }
    const onData = (d) => {
      if (typeof d !== 'string') return; // all HotMic traffic is JSON strings
      if (link.peer.authed) {
        if (link.open) link.peer.handlers.onMessage(d);
        return;
      }
      // Serialize pre-auth frames: the master's 'peers' advertisement can race
      // the auth reply on a just-opened channel.
      link.peer.authChain = (link.peer.authChain || Promise.resolve())
        .then(() => this._onAuthFrame(link, conn, initiator, d))
        .catch(() => { /* link fails inside */ });
    };
    conn.on('data', onData);
    conn.on('close', () => {
      this.clock.clearTimeout(authTimer);
      if (this.links.get(link.id) === link) link.peer.handlers.onClose();
    });
    conn.on('error', () => {
      this.clock.clearTimeout(authTimer);
      if (this.links.get(link.id) === link) link.peer.handlers.onClose();
    });
  }

  async _onAuthFrame(link, conn, initiator, raw) {
    if (link.peer.authed) { // normal traffic that raced the auth completion
      if (link.open) link.peer.handlers.onMessage(raw);
      return;
    }
    let m = null;
    try { m = JSON.parse(raw); } catch { this._fail(link); return; }
    if (link.peer.authed) return;
    if (!m || m.t !== 'a' || typeof m.d !== 'string') { this._fail(link); return; }
    let sealedEnv = null;
    try { sealedEnv = JSON.parse(m.d); } catch { this._fail(link); return; }
    const env = await this.open(sealedEnv).catch((e) => { this._dbg('auth open threw: ' + String(e && e.message || e).slice(0, 60)); return null; });
    if (!env || typeof env.ts !== 'number'
        || Math.abs(this.wallNow() - env.ts) > this.cfg.RTC_SIGNAL_MAX_AGE_MS) {
      this._dbg('auth reject: bad envelope');
      this._fail(link); return;
    }
    // Responder: the challenger must claim the id it dialled from. Initiator:
    // the reply proves the room key; the master's real device id is learned from
    // its 'peers' advertisement.
    if (!initiator && env.f !== link.id) { this._dbg('auth reject: id mismatch'); this._fail(link); return; }
    if (initiator && (!env.f || !ID.test(env.f))) { this._dbg('auth reject: bad master id'); this._fail(link); return; }
    if (!initiator) {
      // Responder answers the challenge with its own sealed hello.
      const back = await this.seal({ f: this.selfId, ts: this.wallNow() }).catch(() => null);
      if (!back) { this._fail(link); return; }
      try { conn.send(JSON.stringify({ t: 'a', d: back })); } catch { return; }
    }
    link.peer.authed = true;
    this._dbg('link authed ' + link.id.slice(0, 8));
    if (!link.open) this._onOpen(link);
  }

  async _startAuth(link, conn, initiator) {
    if (!initiator) return; // responder waits for the challenge
    const hello = await this.seal({ f: this.selfId, ts: this.wallNow() }).catch(() => null);
    if (!hello || this.links.get(link.id) !== link) { this._fail(link); return; }
    try { conn.send(JSON.stringify({ t: 'a', d: hello })); } catch { this._fail(link); }
  }

  /** Cloud id for a mesh device id (members) or the slot. */
  _cloudId(id) { return id === this.slotId ? this.slotId : 'm' + this.tag8 + id; }

  // ---- overridden discovery / roles ------------------------------------------------

  async _discover() {
    if (!this.running || this.probing || this.role === 'master') return;
    if (this._openLinks().some((l) => l.isMaster)) return;
    this.probing = true;
    try {
      const ok = await this._ensureMemberPeer();
      if (!ok || !this.running) return;
      await this._probeSlot();
    } catch (err) {
      if (this.running) {
        this._cloudDown(err && err.message);
        this._cloudBackoff();
      }
    } finally {
      this.probing = false;
    }
    this._emit();
  }

  /** Dial the master slot. No answer (or no link) => claim the slot ourselves. */
  async _probeSlot() {
    if (this.links.has(this.slotId) || this._backedOff(this.slotId)) return;
    const link = this._newLink(this.slotId, true, 'server');
    const outcome = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          try { this.memberPeer.removeListener('error', onErr); } catch { /* ignore */ }
          resolve(v);
        }
      };
      const onErr = (err) => { if (err && err.type === 'peer-unavailable') finish('none'); };
      this.memberPeer.on('error', onErr);
      const origClose = link.peer.handlers.onClose;
      link.peer.handlers.onClose = () => { origClose(); finish('none'); };
      try {
        const conn = this.memberPeer.connect(this.slotId, { reliable: true });
        this._bindConn(link, conn, true);
      } catch { finish('none'); }
      this.clock.setTimeout(() => finish(link.open ? 'master' : 'none'), this.cfg.RTC_PROBE_WAIT_MS);
    });
    this._dbg('probe outcome ' + outcome);
    if (!this.running) return;
    if (outcome === 'master') { this.serverOk = true; this.error = null; return; }
    if (this.links.get(this.slotId) === link && !link.open) this._fail(link);
    this.failedAt.delete(this.slotId); // claim next, not in 60s
    await this._claimSlot();
  }

  async _claimSlot() {
    try {
      await this._ensureSlotPeer();
      if (!this.running) return;
      this.serverOk = true; this.error = null;
      this._dbg('slot claimed -> master');
      this._becomeMaster();
    } catch (err) {
      if (err && err.idTaken) {
        // Someone else holds the slot: they are the master; probe again soon.
        this._dbg('claim id-taken -> backoff');
        this._cloudBackoff();
      } else {
        this._cloudDown(err && err.message);
        this._cloudBackoff();
      }
    }
  }

  _cloudBackoff() {
    this.cloudBackoff = Math.min(this.cloudBackoff ? this.cloudBackoff * 2 : this.cfg.RTC_RETRY_MS, 15000);
    this._clear('recheck');
    this.timers.recheck = this.clock.setTimeout(() => {
      this.timers.recheck = null;
      this.cloudBackoff = 0;
      if (this.running) this._discover();
    }, this.cloudBackoff);
  }

  _cloudDown(why) {
    this.serverOk = false;
    this.error = `cloud unreachable: ${String(why || 'error')}`.slice(0, 200);
    this._emit();
  }

  async _refresh() {
    // Masters keep the slot alive simply by holding the cloud socket. Detect a
    // lower-id master only via gossip (base _onPeers steps us down).
    if (!this.running || this.role !== 'master') return;
    if (this.slotPeer && this.slotPeer.disconnected && !this.slotPeer.destroyed) {
      try { this.slotPeer.reconnect(); } catch { /* next tick */ }
    }
  }

  _check() {
    if (!this.running || this.role === 'master') return;
    if (this._openLinks().some((l) => l.isMaster)) return;
    if (this.probing || this.cloudBackoff) return;
    this._discover();
  }

  _onInboundConn(conn) {
    if (!this.running) { try { conn.close(); } catch { /* ignore */ } return; }
    // conn.peer = "m" + tag8 + memberSelfId
    const raw = typeof conn.peer === 'string' ? conn.peer : '';
    const id = raw.startsWith('m' + this.tag8) ? raw.slice(1 + this.tag8.length) : raw;
    if (!ID.test(id) || id === this.selfId) { try { conn.close(); } catch { /* ignore */ } return; }
    const existing = this.links.get(id);
    if (existing) { this.links.delete(id); this._closeLink(existing); }
    if (this.links.size >= this.cfg.RTC_MAX_PEERS) { try { conn.close(); } catch { /* ignore */ } return; }
    this._dbg('inbound member ' + id.slice(0, 8));
    const link = this._newLink(id, false, 'server');
    this._bindConn(link, conn, false);
  }

  // member↔member dialling (gossip): direct cloud connections, no relays needed
  async _connectTo(id, via) {
    if (!this.running || !ID.test(id) || id === this.selfId) return;
    if (this.links.has(id) || this.links.size >= this.cfg.RTC_MAX_PEERS) return;
    if (this.role === 'master') return; // members dial us; we don't dial out
    if (!this.memberPeer || !this.memberPeer.open) return;
    const link = this._newLink(id, true, 'server');
    try {
      const conn = this.memberPeer.connect(this._cloudId(id), { reliable: true });
      this._bindConn(link, conn, true);
    } catch {
      if (this.links.get(id) === link) this._fail(link);
    }
  }

  // ---- overrides / no-ops ------------------------------------------------------------

  _ensureInbox() { /* no server inbox on the cloud driver */ }

  status() {
    let state;
    const open = this._openLinks().length;
    if (!this.running) state = 'idle';
    else if (open > 0 || (this.role === 'master' && this.slotPeer && this.slotPeer.open)) state = 'up';
    else if (this.cloudBackoff || this.probing || !this.memberPeer || !this.memberPeer.open) state = 'connecting';
    else state = this.serverOk === false ? 'unavailable' : 'connecting';
    return { state, role: this.role, peers: open, error: this.error };
  }

  stop() {
    this.running = false;
    for (const name of Object.keys(this.timers)) this._clear(name);
    try { this.abort?.abort(); } catch { /* ignore */ }
    for (const link of [...this.links.values()]) { this.links.delete(link.id); this._closeLink(link); }
    try { this.memberPeer?.destroy(); } catch { /* ignore */ }
    try { this.slotPeer?.destroy(); } catch { /* ignore */ }
    this.memberPeer = null; this.memberPeerReady = null;
    this.slotPeer = null; this.slotReady = null;
    this.role = 'member';
    this._emit(true);
  }
}
