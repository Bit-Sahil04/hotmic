// WebRTC LAN mesh for one meeting room. Pure logic: WebRTC, the rendezvous
// server, crypto and the clock are injected (see offscreen.js / test/mesh.test.js).
//
// Discovery ("listen first, then become master"):
//   1. Ask the rendezvous server for the room's masters and try to open a
//      data channel to each one. Links use host (LAN) ICE candidates only, with
//      no STUN/TURN, so a master on another network is simply unreachable.
//   2. Reached a master => member. None reachable within RTC_LISTEN_MS => become
//      a master: register with the server and answer newcomers' offers.
//      Normally that is one master per LAN.
//   3. Inside the mesh, members exchange peer lists and connect to everyone
//      else, with signalling relayed over existing links (no server). The lower
//      device id initiates, so there is no glare.
//   4. Masters that can reach each other merge: the higher id steps down.
//      If a master leaves or dies, the lowest-id remaining member takes over.
// The server only ever sees a room tag, random ids and AES-GCM-sealed SDP blobs.

const SERVER = 'server';
const ID = /^[a-f0-9]{8,32}$/;

export class RoomMesh {
  /**
   * @param {object} o
   * @param {string} o.selfId
   * @param {string} [o.alias] routing id of this room's master slot (deterministic
   *                            providers like the PeerJS cloud); the master also accepts
   *                            sealed signalling addressed to it, and members link to it.
   * @param {{now():number, wallNow?():number, setTimeout:Function, clearTimeout:Function}} o.clock
   * @param {{masters():Promise<string[]>, register(id):Promise<string[]>, unregister(id):Promise<void>,
   *          post(to,from,data):Promise<void>, take(id,waitS,abortSignal):Promise<{from,data}[]>}} o.signal
   * @param {(obj:object)=>Promise<string>} o.seal
   * @param {(env:object)=>Promise<object|null>} o.open
   * @param {(handlers:{onOpen,onMessage,onClose})=>Peer} o.createPeer
   * @param {object} o.config
   * @param {(data:string)=>void} o.onData
   * @param {(status:object)=>void} [o.onStatus]
   * @param {()=>number} [o.random]
   */
  constructor(o) {
    this.selfId = o.selfId;
    this.alias = o.alias || null;
    this.clock = o.clock;
    this.wallNow = o.clock.wallNow || (() => Date.now());
    this.signal = o.signal;
    this.seal = o.seal;
    this.open = o.open;
    this.createPeer = o.createPeer;
    this.cfg = o.config;
    this.onData = o.onData;
    this.onStatus = o.onStatus || (() => {});
    this.random = o.random || Math.random;

    /** @type {Map<string, Link>} */
    this.links = new Map();
    this.role = 'member';
    this.registered = false;
    this.decided = false;
    this.running = false;
    this.serverOk = null;
    this.error = null;
    this.failedAt = new Map();
    this.pendingServer = 0;
    this.inboxRunning = false;
    this.discovering = false;
    this.timers = {};
    this.abort = null;
    this._lastStatus = '';
  }

  // ---- lifecycle ---------------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.abort = typeof AbortController === 'function' ? new AbortController() : null;
    this._emit();
    // Small jitter so devices that open the meeting at the same moment rarely race.
    this.timers.start = this.clock.setTimeout(() => { this.timers.start = null; this._discover(); }, Math.floor(this.random() * 300));
    this._every('gossip', this.cfg.RTC_GOSSIP_MS, () => this._gossip());
    this._every('check', this.cfg.RTC_CHECK_MS, () => this._check());
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    for (const name of Object.keys(this.timers)) this._clear(name);
    try { this.abort?.abort(); } catch { /* ignore */ }
    for (const link of [...this.links.values()]) { this.links.delete(link.id); this._closeLink(link); }
    if (this.registered) this.signal.unregister(this.selfId).catch(() => {});
    this.registered = false;
    this.role = 'member';
    this._emit(true);
  }

  /** Send an (already sealed) room envelope to every directly linked peer. */
  broadcast(data) {
    const msg = JSON.stringify({ t: 'd', d: data });
    let n = 0;
    for (const l of this.links.values()) if (l.open && l.peer.send(msg)) n++;
    return n;
  }

  status() {
    const open = this._openLinks().length;
    let state;
    if (!this.running) state = 'idle';
    else if (open > 0 || this.registered) state = 'up';
    else if (!this.decided) state = 'connecting';
    else state = this.serverOk === false ? 'unavailable' : 'connecting';
    return { state, role: this.role, peers: open, error: this.error };
  }

  // ---- discovery / roles ---------------------------------------------------------

  async _discover() {
    if (!this.running || this.discovering || this.timers.decide || this.role === 'master') return;
    this.discovering = true;
    let masters = null;
    try {
      masters = await this.signal.masters();
      this._serverUp();
    } catch (err) {
      this._serverDown(err);
    } finally {
      this.discovering = false;
    }
    if (!this.running || this.role === 'master') return;
    const targets = (masters || []).filter((id) => ID.test(id) && id !== this.selfId && !this.links.has(id) && !this._backedOff(id));
    for (const id of targets) this._connectTo(id, SERVER);
    const reachable = masters !== null;
    this._clear('decide');
    this.timers.decide = this.clock.setTimeout(() => { this.timers.decide = null; this._decide(reachable); },
      targets.length ? this.cfg.RTC_LISTEN_MS : 0);
  }

  _decide(serverReachable) {
    if (!this.running) return;
    this.decided = true;
    if (this.role !== 'master') {
      const open = this._openLinks();
      if (!open.some((l) => l.isMaster)) {
        // Nobody reachable is a master: the lowest id of this cluster takes the role.
        const lowest = [this.selfId, ...open.map((l) => l.id)].sort()[0];
        if (lowest === this.selfId && serverReachable) this._becomeMaster();
      }
    }
    this._emit();
  }

  _becomeMaster() {
    if (this.role === 'master') return;
    this.role = 'master';
    this._gossip();
    this._refresh();
    this._every('refresh', this.cfg.RTC_MASTER_REFRESH_MS, () => this._refresh());
    this._ensureInbox();
    this._emit();
  }

  _stepDown() {
    if (this.role !== 'master') return;
    this.role = 'member';
    this._clear('refresh');
    if (this.registered) this.signal.unregister(this.selfId).catch(() => {});
    this.registered = false;
    this._gossip();
    this._emit();
  }

  async _refresh() {
    if (!this.running || this.role !== 'master') return;
    if (this._openLinks().some((l) => l.isMaster && l.id < this.selfId)) { this._stepDown(); return; }
    try {
      const masters = await this.signal.register(this.selfId);
      if (!this.running || this.role !== 'master') return;
      this.registered = true;
      this._serverUp();
      // Merge with other masters that turn out to be on our LAN (lower id initiates).
      for (const id of masters) {
        if (ID.test(id) && id > this.selfId && !this.links.has(id) && !this._backedOff(id)) this._connectTo(id, SERVER);
      }
    } catch (err) {
      const msg = String(err && err.message || err);
      if (this.alias && /id-taken/i.test(msg)) {
        // Lost the master-slot race (deterministic providers): fall back to member.
        this._stepDown();
        if (!this.links.has(this.alias) && !this._backedOff(this.alias)) this._connectTo(this.alias, SERVER);
      } else {
        this._serverDown(err);
      }
    }
    this._emit();
  }

  /** Member housekeeping: only talks to the server when no master is linked. */
  _check() {
    if (!this.running || this.role === 'master') return;
    if (this._openLinks().some((l) => l.isMaster)) return;
    this._discover();
  }

  // ---- links -----------------------------------------------------------------------

  _openLinks() { return [...this.links.values()].filter((l) => l.open); }

  _backedOff(id) {
    const t = this.failedAt.get(id);
    return t !== undefined && this.clock.now() - t < this.cfg.RTC_FAILED_BACKOFF_MS;
  }

  _newLink(id, initiator, via) {
    /** @type {Link} */
    const link = { id, initiator, via, open: false, isMaster: false, answered: false, countsServer: false, timer: null, closed: false, peer: null };
    link.peer = this.createPeer({
      onOpen: () => this._onOpen(link),
      onMessage: (s) => this._onLinkMessage(link, s),
      onClose: () => this._onClose(link),
    });
    if (initiator && via === SERVER) { link.countsServer = true; this.pendingServer++; this._ensureInbox(); }
    link.timer = this.clock.setTimeout(() => {
      link.timer = null;
      if (!link.open && this.links.get(id) === link) this._fail(link);
    }, this.cfg.RTC_CONNECT_TIMEOUT_MS);
    this.links.set(id, link);
    return link;
  }

  async _connectTo(id, via) {
    if (!this.running || id === this.selfId || this.links.has(id) || this.links.size >= this.cfg.RTC_MAX_PEERS) return;
    if (this.alias && id === this.alias && (this.role === 'master' || this.registered)) return; // that's us
    const link = this._newLink(id, true, via);
    try {
      const sdp = await link.peer.createOffer();
      if (this.links.get(id) !== link) return;
      await this._sendSignal(id, via, { t: 'offer', sdp });
    } catch {
      if (this.links.get(id) === link) this._fail(link);
    }
  }

  _fail(link) {
    if (!link.open) this.failedAt.set(link.id, this.clock.now());
    this.links.delete(link.id);
    this._closeLink(link);
    this._emit();
  }

  _closeLink(link) {
    if (link.closed) return;
    link.closed = true;
    this.clock.clearTimeout(link.timer);
    link.timer = null;
    if (link.countsServer) { link.countsServer = false; this.pendingServer--; }
    try { link.peer.close(); } catch { /* ignore */ }
  }

  _onOpen(link) {
    if (this.links.get(link.id) !== link || link.closed) return;
    link.open = true;
    this.clock.clearTimeout(link.timer);
    link.timer = null;
    if (link.countsServer) { link.countsServer = false; this.pendingServer--; }
    this.failedAt.delete(link.id);
    this._sendPeers(link);
    this._emit();
  }

  _onClose(link) {
    const current = this.links.get(link.id) === link;
    const wasOpen = link.open;
    const wasMaster = link.isMaster;
    if (current) this.links.delete(link.id);
    this._closeLink(link);
    if (!current || !this.running) return;
    this._emit();
    if (wasOpen && (wasMaster || this._openLinks().length === 0)) {
      // Lost our master (or everyone): re-check soon; jitter avoids a stampede.
      this._clear('recheck');
      this.timers.recheck = this.clock.setTimeout(() => { this.timers.recheck = null; this._check(); }, 200 + Math.floor(this.random() * 400));
    }
  }

  // ---- signalling ------------------------------------------------------------------

  async _sendSignal(to, via, sig) {
    const data = await this.seal({ ...sig, from: this.selfId, to, ts: this.wallNow() });
    if (via === SERVER) {
      await this.signal.post(to, this.selfId, data);
    } else {
      const relay = this.links.get(via);
      if (!relay || !relay.open) throw new Error('relay link gone');
      relay.peer.send(JSON.stringify({ t: 'relay', to, from: this.selfId, data }));
    }
  }

  async _onSealedSignal(from, data, via) {
    if (!this.running || !ID.test(from) || typeof data !== 'string' || data.length > 16384) return;
    let env;
    try { env = JSON.parse(data); } catch { return; }
    const sig = await this.open(env);
    // With a deterministic master slot, offers arrive addressed to the alias and
    // the master's answers arrive labelled with it (the sender's routing id).
    const forMe = sig.to === this.selfId || (this.alias && this.role === 'master' && sig.to === this.alias);
    const senderOk = sig.from === from || (this.alias && from === this.alias);
    if (!sig || !senderOk || !forMe || typeof sig.sdp !== 'string') return;
    if (typeof sig.ts !== 'number' || Math.abs(this.wallNow() - sig.ts) > this.cfg.RTC_SIGNAL_MAX_AGE_MS) return;
    if (sig.t === 'offer') await this._onOffer(from, sig.sdp, via);
    else if (sig.t === 'answer') this._onAnswer(from, sig.sdp);
  }

  async _onOffer(from, sdp, via) {
    if (!this.running) return;
    const existing = this.links.get(from);
    if (existing) {
      // Glare: both offered. The lower id's offer wins on both sides.
      if (!existing.open && existing.initiator && this.selfId < from) return;
      this.links.delete(from);
      this._closeLink(existing);
    }
    if (this.links.size >= this.cfg.RTC_MAX_PEERS) return;
    const link = this._newLink(from, false, via);
    try {
      const answer = await link.peer.acceptOffer(sdp);
      if (this.links.get(from) !== link) return;
      await this._sendSignal(from, via, { t: 'answer', sdp: answer });
    } catch {
      if (this.links.get(from) === link) this._fail(link);
    }
  }

  _onAnswer(from, sdp) {
    const link = this.links.get(from);
    if (!link || !link.initiator || link.answered || link.open) return;
    link.answered = true;
    Promise.resolve().then(() => link.peer.acceptAnswer(sdp)).catch(() => {
      if (this.links.get(from) === link) this._fail(link);
    });
  }

  _ensureInbox() {
    if (this.inboxRunning || !this.running) return;
    this.inboxRunning = true;
    this._inboxLoop();
  }

  async _inboxLoop() {
    try {
      while (this.running && (this.role === 'master' || this.pendingServer > 0)) {
        let msgs;
        try {
          msgs = await this.signal.take(this.selfId, this.cfg.RTC_INBOX_WAIT_S, this.abort?.signal);
          this._serverUp();
        } catch (err) {
          if (!this.running) break;
          this._serverDown(err);
          await new Promise((r) => this.clock.setTimeout(r, this.cfg.RTC_RETRY_MS));
          continue;
        }
        for (const m of msgs || []) if (m && typeof m === 'object') this._onSealedSignal(m.from, m.data, SERVER);
      }
    } finally {
      this.inboxRunning = false;
    }
  }

  // ---- in-mesh control messages ---------------------------------------------------------

  _onLinkMessage(link, s) {
    if (this.links.get(link.id) !== link || !link.open || typeof s !== 'string' || s.length > 65536) return;
    let m;
    try { m = JSON.parse(s); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'd') { if (typeof m.d === 'string') this.onData(m.d); }
    else if (m.t === 'peers') this._onPeers(link, m);
    else if (m.t === 'relay') this._onRelay(link, m);
  }

  _onPeers(link, m) {
    const wasMaster = link.isMaster;
    link.isMaster = m.m === true;
    if (this.role === 'master' && link.isMaster && link.id < this.selfId) this._stepDown();
    if (Array.isArray(m.ids)) {
      for (const id of m.ids.slice(0, this.cfg.RTC_MAX_PEERS)) {
        if (typeof id === 'string' && ID.test(id) && id !== this.selfId && !this.links.has(id) && this.selfId < id) {
          this._connectTo(id, link.id);
        }
      }
    }
    // Found a master while still listening: no need to wait for the listen window.
    if (link.isMaster && !this.decided && this.timers.decide) {
      this._clear('decide');
      this._decide(true);
    }
    if (wasMaster !== link.isMaster) this._emit();
  }

  _onRelay(link, m) {
    if (!ID.test(m.to) || !ID.test(m.from) || typeof m.data !== 'string' || m.data.length > 16384) return;
    if (m.to === this.selfId) { this._onSealedSignal(m.from, m.data, link.id); return; }
    const target = this.links.get(m.to);
    if (target && target.open && m.from === link.id) {
      target.peer.send(JSON.stringify({ t: 'relay', to: m.to, from: m.from, data: m.data }));
    }
  }

  _sendPeers(link) {
    const ids = this._openLinks().map((l) => l.id).filter((id) => id !== link.id);
    link.peer.send(JSON.stringify({ t: 'peers', ids, m: this.role === 'master' }));
  }

  _gossip() { for (const l of this._openLinks()) this._sendPeers(l); }

  // ---- misc --------------------------------------------------------------------------------

  _serverUp() { if (this.serverOk !== true || this.error) { this.serverOk = true; this.error = null; this._emit(); } }

  _serverDown(err) {
    this.serverOk = false;
    this.error = `discovery server unreachable: ${String(err && err.message || err)}`.slice(0, 200);
    this._emit();
  }

  _every(name, ms, fn) {
    const tick = () => {
      this.timers[name] = this.clock.setTimeout(tick, ms);
      try { fn(); } catch { /* keep ticking */ }
    };
    this._clear(name);
    this.timers[name] = this.clock.setTimeout(tick, ms);
  }

  _clear(name) {
    if (this.timers[name] != null) this.clock.clearTimeout(this.timers[name]);
    this.timers[name] = null;
  }

  _emit(force = false) {
    const st = this.status();
    const key = JSON.stringify(st);
    if (!force && key === this._lastStatus) return;
    this._lastStatus = key;
    this.onStatus(st);
  }
}

/**
 * @typedef {object} Peer
 * @property {() => Promise<string>} createOffer
 * @property {(sdp:string) => Promise<string>} acceptOffer
 * @property {(sdp:string) => Promise<void>} acceptAnswer
 * @property {(s:string) => boolean} send
 * @property {() => void} close
 *
 * @typedef {object} Link
 * @property {string} id
 * @property {boolean} initiator
 * @property {string} via            'server' or the id of the relaying peer
 * @property {boolean} open
 * @property {boolean} isMaster      as advertised by the peer
 * @property {boolean} answered
 * @property {boolean} countsServer
 * @property {boolean} closed
 * @property {any} timer
 * @property {Peer} peer
 */
