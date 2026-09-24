// Local microphone state: the *Google Meet* mute state of this tab (never the OS mic).
//
//   MUTED | UNMUTED | UNKNOWN   (reported by the Meet adapter, never assumed)
//
// The controller holds a desired state (derived from ownership) and reconciles:
// it issues commands, waits for the adapter to confirm the *actual* state, retries,
// and marks itself inconsistent if Meet does not follow.

import { StateMachine } from '../shared/fsm.js';

export const MIC = Object.freeze({ MUTED: 'MUTED', UNMUTED: 'UNMUTED', UNKNOWN: 'UNKNOWN' });

const ANY = [MIC.MUTED, MIC.UNMUTED, MIC.UNKNOWN];
const MIC_T = { [MIC.MUTED]: ANY, [MIC.UNMUTED]: ANY, [MIC.UNKNOWN]: ANY };

export class MicController {
  /**
   * @param {{clock:any, config:any,
   *          sendCommand:(cmd:{id:number, muted:boolean})=>void,
   *          onEvent:(evt:{type:string, state?:string, target?:string})=>void}} deps
   */
  constructor({ clock, config, sendCommand, onEvent }) {
    this.clock = clock;
    this.config = config;
    this.sendCommand = sendCommand;
    this.onEvent = onEvent;
    this.fsm = new StateMachine('mic', MIC.UNKNOWN, MIC_T);
    this.desired = null;       // null => not enforcing (not participating)
    this.pending = null;       // {id, target, at}
    this.attempts = 0;         // failed attempts for current target
    this.inconsistent = null;  // {reason, since} | null
    this.nextId = 1;
    this.lastCommandAt = -Infinity;
  }

  get actual() { return this.fsm.state; }

  /**
   * Adapter report. cause: 'command' (our click took effect), 'external' (user or
   * Meet changed it) or 'initial'.
   */
  onMeetState(state, cause, now) {
    if (!ANY.includes(state)) state = MIC.UNKNOWN;
    const changed = this.fsm.transition(state, cause);
    if (this.pending && state === this.pending.target) this._resolved();
    if (changed && cause === 'external') this.onEvent({ type: 'external', state });
    if (changed && state === MIC.UNKNOWN) this.onEvent({ type: 'unknown' });
    return changed;
  }

  onCommandResult({ id, ok, mic }, now) {
    if (mic && ANY.includes(mic) && mic !== this.actual) this.fsm.transition(mic, 'command result');
    if (!this.pending || this.pending.id !== id) return;
    if (ok && this.actual === this.pending.target) return this._resolved();
    this._failedAttempt(now, ok ? 'state did not change' : 'adapter reported failure');
  }

  setDesired(target) {
    if (target !== null && target !== MIC.MUTED && target !== MIC.UNMUTED) throw new Error(`bad target ${target}`);
    if (target === this.desired) return;
    this.desired = target;
    this.attempts = 0;
    this.pending = null;
    if (target === null) this.inconsistent = null;
  }

  /** Called on every evaluation tick. */
  enforce(now) {
    if (this.desired === null) return;
    if (this.actual === this.desired) {
      this.pending = null;
      this.attempts = 0;
      this.inconsistent = null;
      return;
    }
    if (this.pending) {
      if (now - this.pending.at < this.config.MIC_COMMAND_TIMEOUT_MS) return;
      this._failedAttempt(now, 'command timed out');
    }
    const exhausted = this.attempts > this.config.MIC_COMMAND_RETRIES;
    if (exhausted) {
      // Fail closed: never stop trying to mute, just slow down. Never keep retrying unmute.
      if (this.desired !== MIC.MUTED) return;
      if (now - this.lastCommandAt < this.config.MIC_MUTE_RETRY_SLOW_MS) return;
    }
    this._issue(now);
  }

  /** One-shot mute used when leaving sharing: mute, then stop enforcing. */
  muteOnce(now) {
    if (this.actual !== MIC.MUTED) this._issue(now, MIC.MUTED);
    this.desired = null;
    this.inconsistent = null;
  }

  // ---- internals -------------------------------------------------------------

  _issue(now, target = this.desired) {
    const id = this.nextId++;
    this.pending = { id, target, at: now };
    this.lastCommandAt = now;
    this.sendCommand({ id, muted: target === MIC.MUTED });
  }

  _resolved() {
    this.pending = null;
    this.attempts = 0;
    if (this.actual === this.desired) this.inconsistent = null;
  }

  _failedAttempt(now, why) {
    const target = this.pending ? this.pending.target : this.desired;
    this.pending = null;
    this.attempts++;
    if (this.attempts > this.config.MIC_COMMAND_RETRIES) {
      const reason = this.actual === MIC.UNKNOWN
        ? 'Meet microphone state cannot be determined'
        : `Meet did not ${target === MIC.MUTED ? 'mute' : 'unmute'} (${why})`;
      if (!this.inconsistent) this.inconsistent = { reason, since: now };
      this.onEvent({ type: 'command-failed', target });
    }
  }
}
