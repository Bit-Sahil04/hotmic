// Input Manager: turns raw key events (forwarded by the Meet content script) and
// UI clicks into debounced "I want / no longer want the microphone" intents.
//
// PTT:    IDLE -> PRESS_PENDING -> HELD -> RELEASE_PENDING -> IDLE
//         SUPPRESSED = key still physically down but ownership was lost; ignored until key-up.
// Toggle: OFF <-> ON, one flip per physical key press, rate-limited.

import { StateMachine } from '../shared/fsm.js';

export const PTT = Object.freeze({
  IDLE: 'IDLE', PRESS_PENDING: 'PRESS_PENDING', HELD: 'HELD',
  RELEASE_PENDING: 'RELEASE_PENDING', SUPPRESSED: 'SUPPRESSED',
});
export const TOGGLE = Object.freeze({ OFF: 'OFF', ON: 'ON' });

const PTT_T = {
  [PTT.IDLE]: [PTT.PRESS_PENDING],
  [PTT.PRESS_PENDING]: [PTT.HELD, PTT.IDLE, PTT.SUPPRESSED],
  [PTT.HELD]: [PTT.RELEASE_PENDING, PTT.IDLE, PTT.SUPPRESSED],
  [PTT.RELEASE_PENDING]: [PTT.HELD, PTT.IDLE],
  [PTT.SUPPRESSED]: [PTT.IDLE],
};
const TOGGLE_T = { [TOGGLE.OFF]: [TOGGLE.ON], [TOGGLE.ON]: [TOGGLE.OFF] };

export class InputManager {
  /**
   * @param {{clock: any, config: any, mode?: 'ptt'|'toggle', onWant: (want:boolean, reason:string)=>void}} deps
   */
  constructor({ clock, config, mode = 'ptt', onWant }) {
    this.clock = clock;
    this.config = config;
    this.mode = mode;
    this.onWant = onWant;
    this.ptt = new StateMachine('ptt', PTT.IDLE, PTT_T);
    this.toggle = new StateMachine('toggle', TOGGLE.OFF, TOGGLE_T);
    this.timer = null;
    this.maxHoldTimer = null;
    this.keyPhysicallyDown = false;
    this.lastToggleAt = -Infinity;
    this.enabled = false;
  }

  get wants() {
    return this.mode === 'ptt'
      ? this.ptt.is(PTT.HELD, PTT.RELEASE_PENDING)
      : this.toggle.is(TOGGLE.ON);
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this._resetAll('input disabled', false);
  }

  setMode(mode) {
    if (mode !== 'ptt' && mode !== 'toggle') return;
    if (mode === this.mode) return;
    this._resetAll('mode changed', true);
    this.mode = mode;
  }

  keyDown(repeat = false) {
    if (!this.enabled) return;
    if (this.mode === 'toggle') return this._toggleKeyDown(repeat);
    if (repeat) return; // OS auto-repeat never starts or extends anything
    switch (this.ptt.state) {
      case PTT.IDLE:
        this.ptt.transition(PTT.PRESS_PENDING, 'keydown');
        this._arm(this.config.PTT_PRESS_DEBOUNCE_MS, () => {
          if (!this.ptt.is(PTT.PRESS_PENDING)) return;
          this.ptt.transition(PTT.HELD, 'press debounced');
          this._armMaxHold();
          this.onWant(true, 'ptt');
        });
        break;
      case PTT.RELEASE_PENDING:
        // key bounced (up+down inside release debounce): keep holding, no new acquire
        this._disarm();
        this.ptt.transition(PTT.HELD, 'bounce');
        break;
      default:
        break; // duplicate keydown while pressed/held/suppressed
    }
  }

  keyUp() {
    this.keyPhysicallyDown = false;
    if (!this.enabled || this.mode === 'toggle') return;
    switch (this.ptt.state) {
      case PTT.PRESS_PENDING:
        this._disarm();
        this.ptt.transition(PTT.IDLE, 'tap shorter than debounce');
        break;
      case PTT.HELD:
        this.ptt.transition(PTT.RELEASE_PENDING, 'keyup');
        this._arm(this.config.PTT_RELEASE_DEBOUNCE_MS, () => {
          if (!this.ptt.is(PTT.RELEASE_PENDING)) return;
          this.ptt.transition(PTT.IDLE, 'release debounced');
          this._clearMaxHold();
          this.onWant(false, 'ptt released');
        });
        break;
      case PTT.SUPPRESSED:
        this.ptt.transition(PTT.IDLE, 'keyup after suppression');
        break;
      default:
        break;
    }
  }

  /** Blur / tab hidden / sleep: PTT fails safe immediately (no debounce). */
  focusLost(reason) {
    this.keyPhysicallyDown = false;
    if (this.mode === 'ptt') {
      const wanted = this.wants;
      this._disarm();
      this._clearMaxHold();
      if (!this.ptt.is(PTT.IDLE)) this.ptt.transition(PTT.IDLE, reason);
      if (wanted) this.onWant(false, reason);
    }
    // Toggle mode keeps its state on blur (presenters switch windows); release
    // there is driven by the user, ownership transfer or safety conditions.
  }

  /** UI toggle button (popup / overlay). Same debounce as the key. */
  uiToggle() {
    if (!this.enabled) return;
    if (this.mode !== 'toggle') return;
    this._flip('ui');
  }

  /**
   * Ownership was lost involuntarily (pre-empted, fenced, manual mute...).
   * Clears the intent so the user must press again; no ping-pong re-acquire.
   */
  ownershipLost(reason) {
    this._disarm();
    this._clearMaxHold();
    if (this.mode === 'ptt') {
      if (this.ptt.is(PTT.HELD, PTT.PRESS_PENDING)) this.ptt.transition(PTT.SUPPRESSED, reason);
      else if (this.ptt.is(PTT.RELEASE_PENDING)) this.ptt.transition(PTT.IDLE, reason);
    } else if (this.toggle.is(TOGGLE.ON)) {
      this.toggle.transition(TOGGLE.OFF, reason);
    }
  }

  dispose() { this._disarm(); this._clearMaxHold(); }

  // ---- internals -------------------------------------------------------------

  _toggleKeyDown(repeat) {
    if (repeat || this.keyPhysicallyDown) return; // one physical press = at most one flip
    this.keyPhysicallyDown = true;
    this._flip('key');
  }

  _flip(source) {
    const now = this.clock.now();
    if (now - this.lastToggleAt < this.config.TOGGLE_DEBOUNCE_MS) return;
    this.lastToggleAt = now;
    if (this.toggle.is(TOGGLE.OFF)) {
      this.toggle.transition(TOGGLE.ON, source);
      this.onWant(true, 'toggle on');
    } else {
      this.toggle.transition(TOGGLE.OFF, source);
      this.onWant(false, 'toggle off');
    }
  }

  _resetAll(reason, notify) {
    const wanted = this.wants;
    this._disarm();
    this._clearMaxHold();
    this.keyPhysicallyDown = false;
    this.ptt.transition(PTT.IDLE, reason); // every PTT state may return to IDLE
    if (this.toggle.is(TOGGLE.ON)) this.toggle.transition(TOGGLE.OFF, reason);
    if (wanted && notify) this.onWant(false, reason);
  }

  _arm(ms, fn) { this._disarm(); this.timer = this.clock.setTimeout(() => { this.timer = null; fn(); }, ms); }
  _disarm() { if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; } }
  _armMaxHold() {
    this._clearMaxHold();
    this.maxHoldTimer = this.clock.setTimeout(() => {
      this.maxHoldTimer = null;
      if (this.mode === 'ptt' && this.wants) this.focusLost('ptt max hold exceeded (missed key-up?)');
    }, this.config.PTT_MAX_HOLD_MS);
  }
  _clearMaxHold() { if (this.maxHoldTimer !== null) { this.clock.clearTimeout(this.maxHoldTimer); this.maxHoldTimer = null; } }
}
