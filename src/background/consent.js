// Consent Manager: owns the local participation state machine.
//
//   NOT_IN_MEETING -> IN_MEETING -> PROMPTED -> SHARING_DECLINED | SHARING_JOINED
//
// Consent is local to one meeting session (one tab + one meeting code + one
// in-call period). Nothing here ever joins automatically.

import { StateMachine } from '../shared/fsm.js';

export const PARTICIPATION = Object.freeze({
  NOT_IN_MEETING: 'NOT_IN_MEETING',
  IN_MEETING: 'IN_MEETING',
  PROMPTED: 'PROMPTED',
  SHARING_DECLINED: 'SHARING_DECLINED',
  SHARING_JOINED: 'SHARING_JOINED',
});

const P = PARTICIPATION;
const TRANSITIONS = {
  [P.NOT_IN_MEETING]: [P.IN_MEETING],
  [P.IN_MEETING]: [P.PROMPTED, P.SHARING_JOINED, P.SHARING_DECLINED, P.NOT_IN_MEETING],
  [P.PROMPTED]: [P.SHARING_JOINED, P.SHARING_DECLINED, P.NOT_IN_MEETING],
  // Declining is sticky for the session; an explicit opt-in from the popup is still allowed.
  [P.SHARING_DECLINED]: [P.SHARING_JOINED, P.NOT_IN_MEETING],
  [P.SHARING_JOINED]: [P.SHARING_DECLINED, P.NOT_IN_MEETING],
};

export class ConsentManager {
  constructor() {
    this.fsm = new StateMachine('participation', P.NOT_IN_MEETING, TRANSITIONS);
    this.promptText = null;
  }

  get state() { return this.fsm.state; }
  get joined() { return this.fsm.is(P.SHARING_JOINED); }
  get declined() { return this.fsm.is(P.SHARING_DECLINED); }
  /** Devices that are undecided or joined announce themselves; declined devices stay silent. */
  get broadcasting() { return this.fsm.is(P.IN_MEETING, P.PROMPTED, P.SHARING_JOINED); }

  enterMeeting() { return this.fsm.transition(P.IN_MEETING, 'meeting detected'); }
  exitMeeting(reason) { this.promptText = null; return this.fsm.transition(P.NOT_IN_MEETING, reason); }

  /** Called whenever the set of live nearby devices (same meeting) changes. */
  updateNearby(livePeers) {
    if (!this.fsm.is(P.IN_MEETING, P.PROMPTED)) return false;
    if (livePeers.length === 0) return false; // keep a shown prompt; never auto-prompt with nobody
    this.promptText = buildPromptText(livePeers);
    return this.fsm.transition(P.PROMPTED, 'nearby device detected');
  }

  /** User explicitly joins. Works with zero other participants. */
  join() { this.promptText = null; return this.fsm.transition(P.SHARING_JOINED, 'user joined'); }
  /** "Not now". */
  decline() { this.promptText = null; return this.fsm.transition(P.SHARING_DECLINED, 'user declined'); }
  /** User leaves microphone sharing for the rest of the session. */
  leave() { return this.fsm.transition(P.SHARING_DECLINED, 'user left sharing'); }
}

export function buildPromptText(peers) {
  const joined = peers.filter((p) => p.status === 'joined');
  const list = joined.length ? joined : peers;
  const first = list[0].name;
  const others = list.length - 1;
  const who = others === 0 ? first : `${first} and ${others} other${others > 1 ? 's' : ''}`;
  const verb = others === 0 ? 'is' : 'are';
  if (joined.length) return `${who} ${verb} nearby and ${verb} using Microphone Sharing for this meeting.`;
  return `${who} ${verb} nearby in this meeting and can use Microphone Sharing.`;
}
