// Ownership Manager: the shared-microphone coordination protocol.
//
// Shared state (replicated on every member):
//   record = { epoch: lease_epoch, owner: owner_device_id | null }
// Every change creates a new record with epoch + 1. Records are merged with a
// deterministic total order (compareRecords); every device adopts the highest
// record it has seen, so stale messages (lower epoch) can never change state.
//
// Local ownership state machine (this device's relationship to the record):
//   NO_OWNER -> REQUESTED -> OWNER -> RELEASED -> NO_OWNER
//
// Safety rules (never two devices unmuted):
//   * A device only unmutes (OWNER) after AGREEMENT: every live joined member has
//     echoed exactly our record and reports its Meet mic as not UNMUTED. This makes
//     simultaneous claims and hand-overs break-before-make and deterministic.
//   * Owner LEASE: members ack our heartbeats; the owner fences itself (mutes and
//     releases) LEASE_SAFETY_MARGIN_MS before any member could expire it.
//   * Observers expire an owner not heard for LEASE_TIMEOUT_MS (new epoch, no owner).
//   * Transfer to a requester only after the minimum-hold floor — shorter
//     (MIN_OWNERSHIP_IDLE_MS) if the owner has been silent since acquiring the mic,
//     full (MIN_OWNERSHIP_ACTIVE_MS) if they talked or activity is unknown — and
//     only when the owner is not speaking: no fresh activity samples, or quiet
//     for ACTIVITY_IDLE_MS. While the owner keeps talking with a fresh signal
//     the request waits, however long.

import { StateMachine } from '../shared/fsm.js';
import { MIC } from './mic.js';

export const OWNERSHIP = Object.freeze({
  NO_OWNER: 'NO_OWNER', REQUESTED: 'REQUESTED', OWNER: 'OWNER', RELEASED: 'RELEASED',
});
const O = OWNERSHIP;
const TRANSITIONS = {
  [O.NO_OWNER]: [O.REQUESTED],
  [O.REQUESTED]: [O.OWNER, O.NO_OWNER],
  [O.OWNER]: [O.RELEASED],
  [O.RELEASED]: [O.NO_OWNER],
};

/** > 0 if a wins over b. Higher epoch wins; same epoch: an owner beats none; lower id wins. */
export function compareRecords(a, b) {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const an = a.owner ? 1 : 0;
  const bn = b.owner ? 1 : 0;
  if (an !== bn) return an - bn;
  if (!a.owner || a.owner === b.owner) return 0;
  return a.owner < b.owner ? 1 : -1;
}

export function sameRecord(a, b) {
  return !!a && !!b && a.epoch === b.epoch && (a.owner ?? null) === (b.owner ?? null);
}

export class OwnershipManager {
  /**
   * @param {object} deps
   * @param {string} deps.selfId
   * @param {{now:()=>number}} deps.clock
   * @param {any} deps.config
   * @param {import('./discovery.js').PeerTable} deps.peers
   * @param {{
   *   micActual: () => string,
   *   coordination: () => {ok:boolean, reason?:string},
   *   synced: () => boolean,
   *   activity: (now:number) => {known:boolean, idleMs:number},
   *   requestSend: (reason:string) => void,
   *   onLost: (reason:string) => void,
   * }} deps.hooks
   */
  constructor({ selfId, clock, config, peers, hooks, record }) {
    this.selfId = selfId;
    this.clock = clock;
    this.config = config;
    this.peers = peers;
    this.hooks = hooks;
    this.fsm = new StateMachine('ownership', O.NO_OWNER, TRANSITIONS);
    this.record = record ? { ...record } : { epoch: 0, owner: null };
    this.recordAt = clock.now();
    this.ownerSince = null;          // local time the current owner began
    this.ownerSinceFromOwner = false;
    this.active = false;             // true while SHARING_JOINED
    this.want = false;
    this.wantSince = null;
    this.claimAt = null;
    this.backoffUntil = -Infinity;
    this.sentTimes = new Map();      // our heartbeat seq -> local send time
    this.lastEvent = null;           // {reason, at}
    this.status = '';                // human-readable reason we're waiting
  }

  get state() { return this.fsm.state; }
  get holdsRecord() { return this.record.owner === this.selfId; }
  get claimPending() { return this.holdsRecord && this.fsm.is(O.REQUESTED); }

  activate() { this.active = true; }

  /** Leaving sharing / meeting: give up everything. Caller mutes and broadcasts. */
  deactivate(now, reason) {
    this.want = false;
    this.wantSince = null;
    if (this.holdsRecord) this._setRecord({ epoch: this.record.epoch + 1, owner: null }, now, reason);
    if (this.fsm.is(O.OWNER)) this.fsm.transition(O.RELEASED, reason);
    if (this.fsm.is(O.REQUESTED, O.RELEASED)) this.fsm.transition(O.NO_OWNER, reason);
    this.claimAt = null;
    this.active = false;
  }

  setWant(want, now, reason) {
    if (!this.active || want === this.want) return;
    if (want) {
      this.want = true;
      this.wantSince = now;
      if (this.fsm.is(O.NO_OWNER)) this.fsm.transition(O.REQUESTED, reason);
    } else {
      this.want = false;
      this.wantSince = null;
      if (this.fsm.is(O.OWNER)) {
        this._relinquish(now, reason, { handoff: true, involuntary: false });
      } else if (this.fsm.is(O.REQUESTED)) {
        if (this.holdsRecord) this._abandonClaim(now, reason, { handoff: true });
        this.fsm.transition(O.NO_OWNER, reason);
      }
    }
    this.hooks.requestSend('want changed');
  }

  /** Merge the record carried by a peer heartbeat. */
  observe(peer, now) {
    if (!peer.rec) return;
    if (compareRecords(peer.rec, this.record) > 0) {
      this._adopt(peer.rec, peer.heldMs, now, `record from ${peer.id}`);
    }
    // The owner itself is authoritative for how long it has held the mic.
    if (peer.id === this.record.owner && sameRecord(peer.rec, this.record)
        && peer.heldMs > 0 && !this.ownerSinceFromOwner) {
      this.ownerSince = now - peer.heldMs;
      this.ownerSinceFromOwner = true;
    }
  }

  noteSent(seq, now) {
    this.sentTimes.set(seq, now);
    const horizon = now - 2 * this.config.LEASE_TIMEOUT_MS;
    for (const [s, t] of this.sentTimes) {
      if (t < horizon) this.sentTimes.delete(s); else break; // insertion ordered
    }
  }

  heartbeatFields(now) {
    let h = 0;
    if (this.record.owner && this.ownerSince !== null) {
      if (!this.holdsRecord || this.fsm.is(O.OWNER)) h = Math.max(0, Math.round(now - this.ownerSince));
    }
    const requesting = this.want && this.fsm.is(O.REQUESTED);
    return {
      r: { e: this.record.epoch, o: this.record.owner, h },
      w: requesting ? Math.max(0, Math.round(now - this.wantSince)) : null,
    };
  }

  // ---- Meet adapter feedback -------------------------------------------------

  onMicExternal(state, now) {
    // Case A: owner manually muted in Meet => release (hand to a waiting requester).
    if (state === MIC.MUTED && this.fsm.is(O.OWNER)) {
      this._relinquish(now, 'microphone muted in Meet', { handoff: true, involuntary: true });
    }
    // Case B (non-owner manually unmuted) is handled by the mic controller
    // re-muting; ownership is unchanged.
  }

  onMicUnknown(now) {
    if (this.fsm.is(O.OWNER)) this._relinquish(now, 'Meet microphone state unknown', { involuntary: true });
    else if (this.claimPending) this._abandonClaim(now, 'Meet microphone state unknown', {});
  }

  onMicCommandFailed(target, now) {
    if (target !== MIC.UNMUTED) return;
    if (this.fsm.is(O.OWNER)) this._relinquish(now, 'Meet did not unmute', { involuntary: true });
  }

  // ---- main evaluation ---------------------------------------------------------

  evaluate(now) {
    if (!this.active) return;
    const cfg = this.config;
    const coord = this.hooks.coordination();
    this.status = '';

    if (this.fsm.is(O.RELEASED) && this.hooks.micActual() !== MIC.UNMUTED) {
      this.fsm.transition(O.NO_OWNER, 'mute confirmed');
    }
    if (this.fsm.is(O.NO_OWNER) && this.want) this.fsm.transition(O.REQUESTED, 'still requested');

    if (!this.holdsRecord) {
      // Owner lease expiry (observer side).
      const owner = this.record.owner;
      if (owner && coord.ok && this.hooks.synced()) {
        const p = this.peers.get(owner);
        const ref = Math.max(p ? p.lastHeard : -Infinity, this.recordAt);
        if (this.peers.leftIds.has(owner) || now - ref > cfg.LEASE_TIMEOUT_MS) {
          this._setRecord({ epoch: this.record.epoch + 1, owner: null }, now, 'owner lease expired');
        }
      }
      if (!this.fsm.is(O.REQUESTED)) return;
      if (this.record.owner !== null) {
        this.status = 'waiting for the current owner';
        return;
      }
      if (!coord.ok) { this.status = coord.reason || 'coordination unavailable'; return; }
      if (!this.hooks.synced()) { this.status = 'syncing with nearby devices'; return; }
      if (now < this.backoffUntil) { this.status = 'retrying'; return; }
      this._setRecord({ epoch: this.record.epoch + 1, owner: this.selfId }, now, 'claim');
      this.claimAt = now;
      // fall through: with no other members agreement is immediate
    }

    if (this.fsm.is(O.REQUESTED)) {
      if (!coord.ok) {
        this._abandonClaim(now, `coordination lost: ${coord.reason}`, {});
        return;
      }
      if (this.claimAt === null) this.claimAt = now;
      const ag = this._agreement(now);
      const lease = this._leaseCheck(now);
      if (ag.ok && lease.ok) {
        this.fsm.transition(O.OWNER, 'agreement reached');
        this.ownerSince = now;
        this.ownerSinceFromOwner = true;
        this.claimAt = null;
        this.lastEvent = { reason: 'acquired microphone', at: now };
        this.hooks.requestSend('became owner');
        return;
      }
      this.status = ag.ok ? 'waiting for acknowledgements' : ag.reason;
      if (now - this.claimAt > cfg.CLAIM_TIMEOUT_MS) {
        this._abandonClaim(now, 'claim not agreed in time', {});
        this.backoffUntil = now + cfg.CLAIM_RETRY_BACKOFF_MS;
      }
      return;
    }

    if (this.fsm.is(O.OWNER)) {
      if (!coord.ok) return this._relinquish(now, `coordination lost: ${coord.reason}`, { involuntary: true });
      if (this.hooks.micActual() === MIC.UNKNOWN) {
        return this._relinquish(now, 'Meet microphone state unknown', { involuntary: true });
      }
      const lease = this._leaseCheck(now);
      if (!lease.ok) return this._relinquish(now, `lost contact with ${lease.peer.name}`, { involuntary: true });
      const conflict = this.peers.liveJoined(now).find((p) => p.mic === MIC.UNMUTED
        && p.unmutedSince !== null && now - p.unmutedSince > cfg.UNMUTED_CONFLICT_GRACE_MS);
      if (conflict) return this._relinquish(now, `${conflict.name} is also unmuted`, { involuntary: true });

      const req = this._pickRequester(now);
      if (!req) return;
      const act = this.hooks.activity(now);
      const held = now - this.ownerSince;
      // Meet's own WebRTC stats say the owner never spoke during this hold (and the
      // signal is fresh) => a waiting requester may take over early. Unknown or
      // stale activity, or any speech, keeps the full floor.
      const floor = act.known && act.idleMs >= held
        ? cfg.MIN_OWNERSHIP_IDLE_MS
        : cfg.MIN_OWNERSHIP_ACTIVE_MS;
      if (held < floor) return;
      // A fresh signal is authoritative: while the owner is still speaking the
      // mic is not relinquished, no matter how long the request has waited. It
      // transfers once the activity dies down (ACTIVITY_IDLE_MS of quiet) or
      // when there is no fresh signal at all.
      if (act.known && act.idleMs < cfg.ACTIVITY_IDLE_MS) return;
      this._relinquish(now, `microphone transferred to ${req.name}`, { to: req, involuntary: true });
    }
  }

  // ---- internals ---------------------------------------------------------------

  _agreement(now) {
    for (const p of this.peers.liveJoined(now)) {
      if (!sameRecord(p.rec, this.record)) return { ok: false, reason: `waiting for ${p.name}` };
      if (p.mic === MIC.UNMUTED) return { ok: false, reason: `waiting for ${p.name} to be muted` };
    }
    return { ok: true };
  }

  /** Owner lease: every live joined member must have acked a recent heartbeat of ours. */
  _leaseCheck(now) {
    const cfg = this.config;
    const valid = cfg.LEASE_TIMEOUT_MS - cfg.LEASE_SAFETY_MARGIN_MS;
    const exempt = valid - cfg.HEARTBEAT_INTERVAL_MS; // newly seen members, not yet acked
    for (const p of this.peers.liveJoined(now)) {
      const seq = p.acks[this.selfId];
      if (seq !== undefined) {
        const sentAt = this.sentTimes.get(seq);
        if (sentAt !== undefined && now - sentAt <= valid) continue;
      } else if (now - p.firstSeen <= exempt) {
        continue;
      }
      return { ok: false, peer: p };
    }
    return { ok: true };
  }

  _pickRequester(now) {
    let best = null;
    for (const p of this.peers.liveJoined(now)) {
      if (p.wantSince === null) continue;
      if (!best || p.wantSince < best.wantSince || (p.wantSince === best.wantSince && p.id < best.id)) best = p;
    }
    return best;
  }

  _adopt(rec, heldMs, now, source) {
    const wasMine = this.holdsRecord;
    this.record = { epoch: rec.epoch, owner: rec.owner };
    this.recordAt = now;
    this.ownerSince = rec.owner && rec.owner !== this.selfId ? now - (heldMs || 0) : null;
    this.ownerSinceFromOwner = false;
    const isMine = this.holdsRecord;

    if (wasMine && !isMine) {
      if (this.fsm.is(O.OWNER)) {
        this.fsm.transition(O.RELEASED, source);
        this._lost(now, rec.owner ? 'microphone taken by another device' : 'ownership expired');
      } else {
        this.claimAt = null; // our claim lost the tie-break; keep requesting
      }
    } else if (isMine && !wasMine) {
      // Ownership handed to us.
      if (this.active && this.want && this.fsm.is(O.REQUESTED)) this.claimAt = now;
      else this._abandonClaim(now, 'handed the microphone but not requesting', { handoff: true });
    }
    this.hooks.requestSend('record adopted');
  }

  _setRecord(rec, now, reason) {
    this.record = { epoch: rec.epoch, owner: rec.owner };
    this.recordAt = now;
    this.ownerSince = rec.owner && rec.owner !== this.selfId ? now : null;
    this.ownerSinceFromOwner = false;
    if (reason !== 'claim') this.lastEvent = { reason, at: now };
    this.hooks.requestSend(reason);
  }

  _relinquish(now, reason, { to = null, handoff = false, involuntary = false }) {
    const next = to || (handoff ? this._pickRequester(now) : null);
    this._setRecord({ epoch: this.record.epoch + 1, owner: next ? next.id : null }, now, reason);
    if (this.fsm.is(O.OWNER)) this.fsm.transition(O.RELEASED, reason);
    if (involuntary) this._lost(now, reason);
  }

  _abandonClaim(now, reason, { handoff = false }) {
    const next = handoff ? this._pickRequester(now) : null;
    this._setRecord({ epoch: this.record.epoch + 1, owner: next ? next.id : null }, now, reason);
    this.claimAt = null;
  }

  _lost(now, reason) {
    this.want = false;
    this.wantSince = null;
    this.lastEvent = { reason, at: now };
    this.hooks.onLost(reason);
  }
}
