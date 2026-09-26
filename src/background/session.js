// State Manager: one RoomSession per (Meet tab, meeting code, in-call period).
//
// Composes the independent state machines/managers:
//   ConsentManager (participation)  PeerTable (discovery/presence)
//   OwnershipManager (shared mic)   MicController (local Meet mic)
//   InputManager (PTT / toggle)
//
// Pure logic: time, transport and the Meet adapter are injected, so the whole
// protocol runs unchanged inside the service worker and in the Node simulator.

import { PROTOCOL_VERSION } from '../shared/config.js';
import { ConsentManager, PARTICIPATION } from './consent.js';
import { PeerTable } from './discovery.js';
import { InputManager } from './input.js';
import { MicController, MIC } from './mic.js';
import { OwnershipManager, OWNERSHIP, sameRecord } from './ownership.js';
import { newDeviceId, sanitizeName, validateMessage } from './messages.js';

export const TRANSPORT = Object.freeze({
  CONNECTING: 'connecting', UP: 'up', LOST: 'lost', UNAVAILABLE: 'unavailable',
});

export class RoomSession {
  /**
   * @param {object} deps
   * @param {{now:()=>number, setTimeout:Function, clearTimeout:Function}} deps.clock monotonic clock
   * @param {() => number} [deps.wallNow] wall clock (sleep detection, replay window)
   * @param {any} deps.config
   * @param {string} deps.meetingId
   * @param {string} [deps.displayName]
   * @param {'ptt'|'toggle'} [deps.mode]
   * @param {string} [deps.transportState]
   * @param {(msg:object)=>void} deps.send   broadcast plaintext control message to the room
   * @param {(cmd:{id:number, muted:boolean})=>void} deps.sendMeetCommand
   * @param {(snapshot:object)=>void} [deps.onChange]
   * @param {(p:{participation:string})=>void} [deps.onPersist]
   * @param {() => string} [deps.idFactory]
   */
  constructor(deps) {
    this.clock = deps.clock;
    this.wallNow = deps.wallNow || (() => Date.now());
    this.config = deps.config;
    this.meetingId = deps.meetingId;
    this.displayName = sanitizeName(deps.displayName || '', this.config.MAX_NAME_LENGTH);
    this.send = deps.send;
    this.onChange = deps.onChange || (() => {});
    this.onPersist = deps.onPersist || (() => {});
    this.idFactory = deps.idFactory || (() => newDeviceId());
    this.transport = deps.transportState || TRANSPORT.CONNECTING;
    this.everUp = this.transport === TRANSPORT.UP;
    this.hotkey = typeof deps.hotkey === 'string' ? deps.hotkey : null;

    this.consent = new ConsentManager();
    this.mic = new MicController({
      clock: this.clock, config: this.config,
      sendCommand: deps.sendMeetCommand,
      onEvent: (evt) => this._onMicEvent(evt),
    });
    this.input = new InputManager({
      clock: this.clock, config: this.config, mode: deps.mode || 'ptt',
      onWant: (want, reason) => {
        this.ownership.setWant(want, this.clock.now(), reason);
        this._evaluate();
      },
    });
    this._newIdentity(null);

    this.seq = 0;
    this.lastSentAt = -Infinity;
    this.nextPeriodicAt = -Infinity;
    this.sendRequested = false;
    this.flushTimer = null;
    this.tickTimer = null;
    this.listeningSince = this.transport === TRANSPORT.UP ? this.clock.now() : null;
    this.lastWall = this.wallNow();
    this.activitySampleAt = null;
    this.activeAt = null;
    this.device = null;
    this.announcedLeave = false; // peers ignore a device id forever after its leave
    this.disposed = false;
    this.lastSig = '';
    this.inEvaluate = false;
  }

  // ---- lifecycle ---------------------------------------------------------------

  start(initialMic = MIC.UNKNOWN) {
    this.consent.enterMeeting();
    this.mic.onMeetState(initialMic, 'initial', this.clock.now());
    this._scheduleTick();
    this._evaluate();
  }

  /** Meeting ended / tab closed / navigated away: leave room and clear everything. */
  dispose(reason = 'left meeting') {
    if (this.disposed) return;
    const now = this.clock.now();
    if (this.consent.joined) {
      this.ownership.deactivate(now, reason);
      this.input.setEnabled(false);
      this._sendHeartbeat(now);
      this.mic.muteOnce(now);
    }
    if (this.consent.broadcasting) this._sendLeave(now);
    this.consent.exitMeeting(reason);
    this.input.dispose();
    if (this.tickTimer !== null) this.clock.clearTimeout(this.tickTimer);
    if (this.flushTimer !== null) this.clock.clearTimeout(this.flushTimer);
    this.disposed = true;
    this.onChange(this.snapshot(now));
  }

  // ---- user actions ---------------------------------------------------------------

  /** Join microphone sharing (works with zero other participants). */
  join() {
    if (this.disposed || this.consent.joined) return false;
    if (!this.consent.fsm.can(PARTICIPATION.SHARING_JOINED)) return false;
    if (this.announcedLeave) {
      // Our previous identity announced 'leave'; come back as a fresh device and resync.
      this._newIdentity(this.ownership.record);
      this.announcedLeave = false;
      if (this.transport === TRANSPORT.UP) this.listeningSince = this.clock.now();
    }
    this.consent.join();
    this.ownership.activate();
    this.input.setEnabled(true);
    this.onPersist({ participation: this.consent.state });
    this._requestSend('joined');
    this._evaluate();
    return true;
  }

  decline() {
    if (this.disposed || !this.consent.decline()) return false;
    this._sendLeave(this.clock.now()); // stop being visible to others
    this.onPersist({ participation: this.consent.state });
    this._evaluate();
    return true;
  }

  leaveSharing() {
    if (this.disposed || !this.consent.joined) return false;
    const now = this.clock.now();
    this.ownership.deactivate(now, 'left microphone sharing');
    this.input.setEnabled(false);
    this._sendHeartbeat(now);
    this._sendLeave(now);
    this.mic.muteOnce(now);
    this.consent.leave();
    this.onPersist({ participation: this.consent.state });
    this._evaluate();
    return true;
  }

  setMode(mode) { this.input.setMode(mode); this._evaluate(); }
  setHotkey(key) { this.hotkey = typeof key === 'string' && key ? key : null; this._evaluate(); }
  setDisplayName(name) {
    this.displayName = sanitizeName(name || '', this.config.MAX_NAME_LENGTH);
    this._requestSend('name');
    this._evaluate();
  }

  // ---- adapter / input events ----------------------------------------------------

  onKey(action, repeat = false) {
    if (action === 'down') this.input.keyDown(repeat);
    else if (action === 'up') this.input.keyUp();
    this._evaluate();
  }

  onFocusLost(reason) { this.input.focusLost(reason); this._evaluate(); }
  uiToggle() { this.input.uiToggle(); this._evaluate(); }

  onMeetState(state, cause = 'external') {
    const changed = this.mic.onMeetState(state, cause, this.clock.now());
    if (changed) this._requestSend('mic changed');
    this._evaluate();
  }

  onMicCommandResult(result) {
    this.mic.onCommandResult(result, this.clock.now());
    this._evaluate();
  }

  /** Owner's island buttons: pass the mic now / restart the request window. */
  acceptHandover() {
    if (this.ownership.acceptHandover(this.clock.now())) this._evaluate();
  }

  cancelHandover() {
    if (this.ownership.cancelHandover(this.clock.now())) this._evaluate();
  }

  /** Browser-reported audio level of Meet's outgoing track (WebRTC stats). Local only. */
  onActivity(level) {
    const now = this.clock.now();
    this.activitySampleAt = now;
    if (typeof level === 'number' && level >= this.config.ACTIVITY_LEVEL_THRESHOLD) this.activeAt = now;
  }

  /**
   * Microphone selected by Meet (observed, never chosen by us). If it becomes
   * unavailable we do not pick another one; we fail closed and tell the user.
   */
  onDevice(info) {
    const wasAvailable = !this.device || this.device.available !== false;
    this.device = info;
    if (info && info.available === false && wasAvailable && this.consent.joined) {
      this._failClosed(this.clock.now(), 'Meet microphone unavailable');
    }
    this._evaluate();
    this._emit(this.clock.now(), true);
  }

  setTransportState(state) {
    if (state === this.transport) return;
    const now = this.clock.now();
    const prev = this.transport;
    this.transport = state;
    if (state === TRANSPORT.UP) this.everUp = true;
    // Any change of network reachability means our view may be stale: fail closed.
    if (prev === TRANSPORT.UP || state === TRANSPORT.UP) this._failClosed(now, 'network connection changed');
    this.listeningSince = state === TRANSPORT.UP ? now : null;
    this._evaluate();
  }

  onNetworkChange() {
    const now = this.clock.now();
    this._failClosed(now, 'network changed');
    if (this.transport === TRANSPORT.UP) this.listeningSince = now;
    this._evaluate();
  }

  /** Decrypted, not yet validated control message from the LAN. */
  receive(raw) {
    if (this.disposed) return;
    const msg = validateMessage(raw, { maxNameLength: this.config.MAX_NAME_LENGTH });
    if (!msg || msg.d === this.deviceId) return;
    if (Math.abs(this.wallNow() - msg.ts) > this.config.MAX_CLOCK_SKEW_MS) return;
    const now = this.clock.now();
    if (msg.k === 'leave') {
      if (this.peers.markLeft(msg)) this._evaluate();
      return;
    }
    const res = this.peers.upsert(msg, now);
    if (!res) return;
    this.ownership.observe(res.peer, now);
    if (this.consent.broadcasting) {
      if (res.isNew) this._requestSend('new peer');
      if (!sameRecord(res.peer.rec, this.ownership.record)) this._requestSend('peer record differs');
      if (this.consent.joined && res.peer.status === 'joined'
          && this.ownership.record.owner === res.peer.id) this._requestSend('ack owner');
    }
    this._evaluate();
  }

  // ---- derived state ---------------------------------------------------------------

  get synced() {
    const now = this.clock.now();
    if (this.transport === TRANSPORT.UP) {
      return this.listeningSince !== null && now - this.listeningSince >= this.config.SYNC_MS;
    }
    return this._localOnly;
  }

  get _localOnly() { return this.transport === TRANSPORT.UNAVAILABLE && !this.everUp; }

  coordination() {
    if (this.mic.actual === MIC.UNKNOWN) return { ok: false, reason: 'Meet microphone state unknown' };
    if (this.transport === TRANSPORT.UP || this._localOnly) return { ok: true };
    if (this.transport === TRANSPORT.LOST || this.transport === TRANSPORT.UNAVAILABLE) {
      return { ok: false, reason: 'connection to nearby devices lost' };
    }
    return { ok: false, reason: 'connecting' };
  }

  activity(now) {
    const known = this.activitySampleAt !== null && now - this.activitySampleAt <= this.config.ACTIVITY_STALE_MS;
    const idleMs = this.activeAt === null ? Infinity : now - this.activeAt;
    return { known, idleMs };
  }

  snapshot(now = this.clock.now()) {
    const o = this.ownership;
    const rec = o.record;
    const ownerIsSelf = rec.owner === this.deviceId;
    const ownerPeer = rec.owner && !ownerIsSelf ? this.peers.get(rec.owner) : null;
    let ownerHeldMs = null;
    if (ownerIsSelf && o.state === OWNERSHIP.OWNER) ownerHeldMs = now - o.ownerSince;
    else if (!ownerIsSelf && rec.owner && o.ownerSince !== null) ownerHeldMs = now - o.ownerSince;

    const joined = this.consent.joined;
    const livePeers = this.peers.live(now);
    const participants = [];
    if (joined) {
      participants.push({
        id: this.deviceId, name: this.displayName || 'You', self: true,
        hasMic: ownerIsSelf && o.state === OWNERSHIP.OWNER, mic: this.mic.actual,
      });
    }
    const byName = (x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id);
    for (const p of livePeers.filter((x) => x.status === 'joined').sort(byName)) {
      participants.push({ id: p.id, name: p.name, self: false, hasMic: rec.owner === p.id, mic: p.mic });
    }
    const nearby = livePeers.filter((p) => p.status !== 'joined').sort(byName).map((p) => ({ id: p.id, name: p.name }));

    const coord = this.coordination();
    const hoRaw = o.handoverView(now);
    const hoPeer = hoRaw ? this.peers.get(hoRaw.requesterId) : null;
    let warning = null;
    if (this.mic.inconsistent) warning = this.mic.inconsistent.reason;
    else if (joined && !coord.ok && coord.reason !== 'connecting') warning = `${cap(coord.reason)} — microphone muted`;
    else if (joined && this.device && this.device.available === false) {
      warning = `Meet microphone unavailable (${this.device.label}) — choose a microphone in Meet`;
    }

    return {
      meetingId: this.meetingId,
      deviceId: this.deviceId,
      displayName: this.displayName,
      participation: this.consent.state,
      prompt: this.consent.state === PARTICIPATION.PROMPTED ? this.consent.promptText : null,
      mode: this.input.mode,
      hotkey: this.hotkey,
      input: { ptt: this.input.ptt.state, toggle: this.input.toggle.state },
      ownership: {
        state: o.state,
        epoch: rec.epoch,
        ownerId: rec.owner,
        ownerIsSelf,
        ownerName: ownerIsSelf ? 'You' : rec.owner ? (ownerPeer ? ownerPeer.name : 'Another device') : null,
        ownerHeldMs: ownerHeldMs === null ? null : Math.max(0, Math.round(ownerHeldMs)),
        ownerSinceKey: o.ownerSince === null ? null : Math.round(o.ownerSince / 250),
        want: o.want,
        status: o.status,
        lastEvent: o.lastEvent ? o.lastEvent.reason : null,
        handover: hoRaw ? {
          requesterName: hoPeer ? hoPeer.name : 'Another device',
          remainingMs: hoRaw.remainingMs,
          paused: hoRaw.paused,
        } : null,
      },
      mic: { actual: this.mic.actual, desired: this.mic.desired, inconsistent: !!this.mic.inconsistent },
      participants,
      nearby,
      transport: this.transport,
      synced: this.synced,
      localOnly: this._localOnly,
      device: this.device,
      wantsActivity: joined && o.state === OWNERSHIP.OWNER,
      warning,
      ended: this.disposed,
    };
  }

  // ---- internals -------------------------------------------------------------------

  _newIdentity(record) {
    this.deviceId = this.idFactory();
    this.peers = new PeerTable({ selfId: this.deviceId, config: this.config });
    this.ownership = new OwnershipManager({
      selfId: this.deviceId, clock: this.clock, config: this.config, peers: this.peers,
      record, // carried verbatim: never forget the current owner or regress the epoch
      hooks: {
        micActual: () => this.mic.actual,
        coordination: () => this.coordination(),
        synced: () => this.synced,
        activity: (now) => this.activity(now),
        requestSend: (reason) => this._requestSend(reason),
        onLost: (reason) => this.input.ownershipLost(reason),
      },
    });
  }

  _failClosed(now, reason) {
    const o = this.ownership;
    if (o.state === OWNERSHIP.OWNER) o._relinquish(now, reason, { involuntary: true });
    else if (o.claimPending) o._abandonClaim(now, reason, {});
    // Requests made under uncertain conditions are dropped; the user must ask again.
    o.setWant(false, now, reason);
    this.input.ownershipLost(reason);
  }

  _onMicEvent(evt) {
    if (!this.consent.joined) return;
    const now = this.clock.now();
    if (evt.type === 'external') this.ownership.onMicExternal(evt.state, now);
    else if (evt.type === 'unknown') this.ownership.onMicUnknown(now);
    else if (evt.type === 'command-failed') this.ownership.onMicCommandFailed(evt.target, now);
  }

  _onResume(now) {
    this._failClosed(now, 'system resumed from sleep');
    this.peers.expireAll();
    this.listeningSince = this.transport === TRANSPORT.UP ? now : null;
  }

  _scheduleTick() {
    this.tickTimer = this.clock.setTimeout(() => {
      this.tickTimer = null;
      if (this.disposed) return;
      const wall = this.wallNow();
      if (wall - this.lastWall > this.config.SLEEP_GAP_MS) this._onResume(this.clock.now());
      this.lastWall = wall;
      this._evaluate();
      this._scheduleTick();
    }, this.config.TICK_MS);
  }

  _evaluate() {
    if (this.disposed || this.inEvaluate) return;
    this.inEvaluate = true;
    try {
      const now = this.clock.now();
      this.peers.prune(now);
      this.consent.updateNearby(this.peers.live(now));
      const joined = this.consent.joined;
      this.input.setEnabled(joined);
      if (joined) {
        this.ownership.evaluate(now);
        this.mic.setDesired(this.ownership.state === OWNERSHIP.OWNER ? MIC.UNMUTED : MIC.MUTED);
      } else if (this.mic.desired !== null) {
        this.mic.setDesired(null);
      }
      this.mic.enforce(now);
      this._maybeSend(now);
      this._emit(now);
    } catch (err) {
      // Malformed state must never leave us unmuted.
      console.error('HotMic session error; failing closed', err);
      try { this._failClosed(this.clock.now(), 'internal error'); } catch { /* ignore */ }
      if (this.consent.joined) { this.mic.setDesired(MIC.MUTED); this.mic.enforce(this.clock.now()); }
    } finally {
      this.inEvaluate = false;
    }
  }

  _requestSend() {
    this.sendRequested = true;
    if (!this.inEvaluate && !this.disposed) this._scheduleFlush(0);
  }

  _scheduleFlush(ms) {
    if (this.flushTimer !== null) return;
    this.flushTimer = this.clock.setTimeout(() => {
      this.flushTimer = null;
      if (!this.disposed) this._maybeSend(this.clock.now());
    }, ms);
  }

  _canSend() { return this.consent.broadcasting && this.transport === TRANSPORT.UP; }

  _maybeSend(now) {
    if (!this._canSend()) { this.sendRequested = false; return; }
    const gapOk = now - this.lastSentAt >= this.config.MIN_SEND_GAP_MS;
    const periodic = now >= this.nextPeriodicAt;
    const claimResend = this.ownership.claimPending && now - this.lastSentAt >= this.config.CLAIM_RESEND_MS;
    if (periodic || claimResend || (this.sendRequested && gapOk)) {
      this._sendHeartbeat(now);
    } else if (this.sendRequested) {
      this._scheduleFlush(this.config.MIN_SEND_GAP_MS - (now - this.lastSentAt));
    }
  }

  _sendHeartbeat(now) {
    if (this.transport !== TRANSPORT.UP) return;
    const seq = this.seq++;
    const own = this.ownership.heartbeatFields(now);
    const joined = this.consent.joined;
    const msg = {
      k: 'hb', v: PROTOCOL_VERSION, d: this.deviceId, s: seq, ts: this.wallNow(),
      n: this.displayName || 'Nearby device',
      st: joined ? 'joined' : 'available',
      m: this.mic.actual,
      syn: this.synced,
      r: own.r,
      w: joined ? own.w : null,
      a: this.peers.ackMap(now),
    };
    this.ownership.noteSent(seq, now);
    this.lastSentAt = now;
    this.nextPeriodicAt = now + this.config.HEARTBEAT_INTERVAL_MS;
    this.sendRequested = false;
    this.send(msg);
  }

  _sendLeave(now) {
    if (this.transport !== TRANSPORT.UP) return;
    this.send({ k: 'leave', v: PROTOCOL_VERSION, d: this.deviceId, s: this.seq++, ts: this.wallNow() });
    this.announcedLeave = true;
  }

  _emit(now, force = false) {
    const snap = this.snapshot(now);
    const { ownerHeldMs, ...rest } = snap.ownership;
    // Countdown changes 10x/s; bucket them so the UI is only notified on
    // half-second steps (the pill interpolates locally between snapshots).
    const ho = rest.handover
      ? { ...rest.handover, remainingMs: Math.ceil(rest.handover.remainingMs / 500) * 500 }
      : null;
    const sig = JSON.stringify({ ...snap, ownership: { ...rest, handover: ho } });
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.onChange(snap);
  }
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }
