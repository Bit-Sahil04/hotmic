// Tiny explicit state machine: states + allowed transitions. Used for the
// participation, ownership and local-microphone machines so that state is never
// a loose collection of booleans.

export class IllegalTransitionError extends Error {}

export class StateMachine {
  /**
   * @param {string} name
   * @param {string} initial
   * @param {Record<string, string[]>} transitions  from -> allowed targets
   * @param {{strict?: boolean, onTransition?: (from:string,to:string,reason:string)=>void}} [opts]
   */
  constructor(name, initial, transitions, opts = {}) {
    if (!(initial in transitions)) throw new Error(`${name}: unknown initial state ${initial}`);
    this.name = name;
    this._state = initial;
    this._transitions = transitions;
    this._strict = opts.strict ?? StateMachine.strict;
    this._onTransition = opts.onTransition;
    this.lastReason = 'initial';
  }

  get state() { return this._state; }
  is(...states) { return states.includes(this._state); }
  can(to) { return (this._transitions[this._state] || []).includes(to); }

  /** Returns true if the state changed. Self-transitions are no-ops. */
  transition(to, reason = '') {
    if (to === this._state) return false;
    if (!this.can(to)) {
      const msg = `${this.name}: illegal transition ${this._state} -> ${to} (${reason})`;
      if (this._strict) throw new IllegalTransitionError(msg);
      console.warn(msg);
      return false;
    }
    const from = this._state;
    this._state = to;
    this.lastReason = reason;
    this._onTransition?.(from, to, reason);
    return true;
  }
}

/** Tests flip this on so any illegal transition fails loudly. */
StateMachine.strict = false;
