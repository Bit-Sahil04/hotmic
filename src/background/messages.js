// Wire protocol (plaintext form, encrypted by crypto.js before leaving the browser).
//
// Only control/state metadata is ever exchanged. There is intentionally no field
// that could carry audio, transcripts or meeting content.
//
// hb  (heartbeat / presence / lease renewal / ownership record propagation)
//   k  : 'hb'
//   v  : protocol version
//   d  : device_id (random, per meeting session)
//   s  : sequence number (per device, monotonically increasing)
//   ts : sender wall clock (replay sanity check only; never used for leases)
//   n  : display name
//   st : sharing status  'available' (in meeting, undecided) | 'joined'
//   m  : Meet mic state  'MUTED' | 'UNMUTED' | 'UNKNOWN'
//   syn: sender has listened long enough to know the room state
//   r  : ownership record as seen by sender  { e: lease_epoch, o: owner_device_id|null, h: held_ms }
//   w  : null, or ms the sender has been requesting the microphone
//   a  : acks { device_id: last seq received from that device }
//
// leave (graceful departure)
//   k: 'leave', v, d, s, ts

import { PROTOCOL_VERSION } from '../shared/config.js';

export const MIC_STATES = ['MUTED', 'UNMUTED', 'UNKNOWN'];
export const SHARE_STATES = ['available', 'joined'];
const ID_RE = /^[a-f0-9]{16}$/;
const MAX_EPOCH = 2 ** 31;
const MAX_ACKS = 64;

export const HB_KEYS = ['k', 'v', 'd', 's', 'ts', 'n', 'st', 'm', 'syn', 'r', 'w', 'a'];
export const LEAVE_KEYS = ['k', 'v', 'd', 's', 'ts'];

export function isDeviceId(x) { return typeof x === 'string' && ID_RE.test(x); }

export function newDeviceId(rand = globalThis.crypto) {
  const b = new Uint8Array(8);
  rand.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const isNonNegInt = (x, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(x) && x >= 0 && x <= max;
const isNonNegNum = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export function sanitizeName(name, maxLen) {
  if (typeof name !== 'string') return '';
  // strip control chars, collapse whitespace
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

/**
 * Validates an incoming decrypted message. Returns a normalised copy or null.
 * Malformed input is dropped, never partially applied.
 */
export function validateMessage(msg, { maxNameLength = 40 } = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (msg.v !== PROTOCOL_VERSION) return null;
  if (!isDeviceId(msg.d) || !isNonNegInt(msg.s) || !isNonNegNum(msg.ts)) return null;

  if (msg.k === 'leave') {
    return { k: 'leave', v: msg.v, d: msg.d, s: msg.s, ts: msg.ts };
  }
  if (msg.k !== 'hb') return null;

  if (!SHARE_STATES.includes(msg.st) || !MIC_STATES.includes(msg.m)) return null;
  if (typeof msg.syn !== 'boolean') return null;
  const r = msg.r;
  if (!r || typeof r !== 'object') return null;
  if (!isNonNegInt(r.e, MAX_EPOCH)) return null;
  if (!(r.o === null || isDeviceId(r.o))) return null;
  if (!isNonNegNum(r.h)) return null;
  if (!(msg.w === null || isNonNegNum(msg.w))) return null;
  const a = msg.a;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const ackEntries = Object.entries(a);
  if (ackEntries.length > MAX_ACKS) return null;
  const acks = {};
  for (const [id, seq] of ackEntries) {
    if (!isDeviceId(id) || !isNonNegInt(seq)) return null;
    acks[id] = seq;
  }
  return {
    k: 'hb', v: msg.v, d: msg.d, s: msg.s, ts: msg.ts,
    n: sanitizeName(msg.n, maxNameLength) || 'Nearby device',
    st: msg.st, m: msg.m, syn: msg.syn,
    r: { e: r.e, o: r.o, h: r.h },
    w: msg.w, a: acks,
  };
}
