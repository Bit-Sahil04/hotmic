// Room identity + message protection.
//
// The meeting code is the shared secret that scopes a sharing room:
//   roomTag = PBKDF2(meeting code, "hotmic/v1/room-tag")      -> routing only
//   roomKey = PBKDF2(meeting code, "hotmic/v1/room-key") AES-GCM
// Devices in other meetings cannot match the tag or decrypt/forge messages, and
// the meeting code itself is never sent on the LAN.

import { CONFIG } from '../shared/config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export const ENVELOPE_PREFIX = '{"p":"hotmic"';

export async function deriveRoom(meetingId, { iterations = CONFIG.KDF_ITERATIONS } = {}) {
  const base = await subtle().importKey('raw', enc.encode(`meet:${meetingId}`), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  const tagBits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('hotmic/v1/room-tag'), iterations }, base, 128);
  const key = await subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('hotmic/v1/room-key'), iterations },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return new RoomCrypto(toHex(new Uint8Array(tagBits)), key);
}

export class RoomCrypto {
  constructor(roomTag, key) {
    this.roomTag = roomTag;
    this.key = key;
    this.aad = enc.encode(roomTag);
  }

  /** Object -> envelope string suitable for the LAN transport. */
  async seal(obj) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: this.aad }, this.key, enc.encode(JSON.stringify(obj)));
    // Key order matters: the native helper filters on ENVELOPE_PREFIX.
    return JSON.stringify({ p: 'hotmic', v: 1, r: this.roomTag, i: b64(iv), c: b64(new Uint8Array(ct)) });
  }

  /** Parsed envelope -> object, or null if it isn't ours / was tampered with. */
  async open(env) {
    if (!env || env.p !== 'hotmic' || env.v !== 1 || env.r !== this.roomTag) return null;
    if (typeof env.i !== 'string' || typeof env.c !== 'string' || env.c.length > 16384) return null;
    try {
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(env.i), additionalData: this.aad }, this.key, unb64(env.c));
      return JSON.parse(dec.decode(pt));
    } catch {
      return null;
    }
  }
}

function toHex(bytes) { return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(str) { const s = atob(str); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
