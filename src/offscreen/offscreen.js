// Offscreen document hosting WebRTC discovery (service workers have no
// RTCPeerConnection). One RoomMesh per active meeting. It relays already
// sealed room envelopes between the service worker and the LAN mesh, exactly
// like the native helper does for UDP.
//
// SW -> offscreen: {type:'config', url, rooms:[meetingId]} | {type:'send', data}
// offscreen -> SW: {type:'status', rooms:{[meetingId]: status}} | {type:'recv', data}

import { CONFIG } from '../shared/config.js';
import { deriveRoom } from '../background/crypto.js';
import { RoomMesh } from './mesh.js';
import { SignalClient } from './signal-client.js';
import { createRtcPeer } from './rtc.js';

const clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** @type {Map<string, {mesh: RoomMesh|null, roomTag: string|null, url: string, pending: Promise<void>}>} */
const rooms = new Map();
const byTag = new Map();
let port = null;
let url = '';

function connect() {
  port = chrome.runtime.connect({ name: 'hotmic-offscreen' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // Service worker restarted: reconnect (this wakes it) and get the current config.
    setTimeout(connect, 500);
  });
  pushStatus();
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'config') configure(String(msg.url || ''), Array.isArray(msg.rooms) ? msg.rooms.map(String) : []);
  else if (msg.type === 'send' && typeof msg.data === 'string') send(msg.data);
}

// '' = built-in discovery service (DEFAULT_DISCOVERY_URL); 'off' = WebRTC
// discovery disabled; otherwise a custom rendezvous server URL.
function configure(nextUrl, wanted) {
  const active = nextUrl !== 'off';
  const urlChanged = nextUrl !== url;
  url = nextUrl;
  for (const [meetingId, r] of rooms) {
    if (!wanted.includes(meetingId) || urlChanged || !active) stopRoom(meetingId, r);
  }
  if (active) for (const meetingId of wanted) if (!rooms.has(meetingId)) startRoom(meetingId);
  pushStatus();
}

function startRoom(meetingId) {
  const entry = { mesh: null, roomTag: null, url, status: { state: 'connecting', role: 'member', peers: 0, error: null } };
  rooms.set(meetingId, entry);
  entry.pending = deriveRoom(meetingId).then((rc) => {
    if (rooms.get(meetingId) !== entry) return;
    const selfId = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    entry.roomTag = rc.roomTag;
    entry.mesh = new RoomMesh({
      selfId, clock, config: CONFIG,
      // '' (built-in) resolves to our rendezvous deployment; custom URL passes through.
      signal: new SignalClient(entry.url || CONFIG.DEFAULT_DISCOVERY_URL, rc.roomTag),
      seal: (obj) => rc.seal(obj),
      open: (env) => rc.open(env),
      createPeer: createRtcPeer,
      onData: (data) => { if (port) port.postMessage({ type: 'recv', data }); },
      onStatus: (st) => { entry.status = st; pushStatus(); },
    });
    byTag.set(rc.roomTag, entry);
    entry.mesh.start();
  }).catch((err) => {
    entry.status = { state: 'unavailable', role: 'member', peers: 0, error: String(err && err.message || err) };
    pushStatus();
  });
}

function stopRoom(meetingId, entry) {
  rooms.delete(meetingId);
  if (entry.roomTag) byTag.delete(entry.roomTag);
  entry.mesh?.stop();
}

function send(data) {
  let env;
  try { env = JSON.parse(data); } catch { return; }
  const entry = env && typeof env.r === 'string' ? byTag.get(env.r) : null;
  entry?.mesh?.broadcast(data);
}

function pushStatus() {
  if (!port) return;
  const out = {};
  for (const [meetingId, r] of rooms) out[meetingId] = r.status;
  try { port.postMessage({ type: 'status', rooms: out }); } catch { /* reconnecting */ }
}

connect();
