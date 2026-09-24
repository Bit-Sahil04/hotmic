// Service worker: wires Meet tabs (content scripts), the popup, the LAN transports
// (native UDP helper and/or WebRTC mesh) and per-meeting crypto to RoomSession instances. All protocol logic lives in
// session.js and friends; this file is glue only.

import { CONFIG, DEFAULT_SETTINGS, contentConfig } from '../shared/config.js';
import { parseMeetingId } from '../shared/meeting.js';
import { RoomSession, TRANSPORT } from './session.js';
import { NativeTransport } from './transport.js';
import { WebRtcTransport } from './webrtc-transport.js';
import { MultiTransport } from './multi-transport.js';
import { deriveRoom } from './crypto.js';
import { sanitizeName } from './messages.js';

const clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** @type {Map<number, TabEntry>} */
const tabs = new Map();
/** @type {Map<number, Set<chrome.runtime.Port>>} */
const popups = new Map();
/** @type {Map<string, Promise<import('./crypto.js').RoomCrypto>>} */
const roomCrypto = new Map();

let settings = { ...DEFAULT_SETTINGS };
const settingsReady = loadSettings();
let transportIdleTimer = null;

const onTransportStatus = () => { for (const e of tabs.values()) applyTransport(e); pushAllPopups(); };
const onTransportMessage = (data) => { if (transport.accept(data)) route(data); };

// Option 1: native messaging helper (UDP multicast/broadcast on the LAN).
const native = new NativeTransport({
  hostName: CONFIG.NATIVE_HOST_NAME,
  config: CONFIG,
  onStatus: onTransportStatus,
  onMessage: onTransportMessage,
  onNetworkChange: () => { for (const e of tabs.values()) e.session?.onNetworkChange(); },
});
// Option 2: WebRTC data channels (LAN-only ICE) found through a rendezvous server.
const webrtc = new WebRtcTransport({ config: CONFIG, onStatus: onTransportStatus, onMessage: onTransportMessage });
const transport = new MultiTransport([native, webrtc]);

// ---------------------------------------------------------------------------
// Settings

async function loadSettings() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  webrtc.setUrl(settings.discoveryUrl);
  if (!settings.displayName) {
    const b = crypto.getRandomValues(new Uint8Array(2));
    settings.displayName = `Guest ${((b[0] << 8) | b[1]) % 1000}`;
    await chrome.storage.local.set({ settings });
  }
}

async function updateSettings(patch = {}) {
  await settingsReady;
  const next = { ...settings };
  if (typeof patch.displayName === 'string') {
    const n = sanitizeName(patch.displayName, CONFIG.MAX_NAME_LENGTH);
    if (n) next.displayName = n;
  }
  if (patch.mode === 'ptt' || patch.mode === 'toggle') next.mode = patch.mode;
  if (typeof patch.pttKey === 'string' && /^[A-Za-z0-9]{1,24}$/.test(patch.pttKey) && patch.pttKey !== 'Escape') {
    next.pttKey = patch.pttKey;
  }
  if (typeof patch.discoveryUrl === 'string') {
    const url = sanitizeDiscoveryUrl(patch.discoveryUrl);
    if (url !== null) next.discoveryUrl = url;
  }
  settings = next;
  await chrome.storage.local.set({ settings });
  webrtc.setUrl(settings.discoveryUrl);
  for (const e of tabs.values()) {
    e.session?.setDisplayName(settings.displayName);
    e.session?.setMode(settings.mode);
    post(e, { type: 'config', config: contentConfig(), settings });
  }
  pushAllPopups();
}

// ---------------------------------------------------------------------------
// Meet tabs

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'hotmic-meet') onMeetPort(port);
  else if (port.name === 'hotmic-popup') onPopupPort(port);
  else if (port.name === 'hotmic-offscreen' && port.sender?.url?.startsWith(chrome.runtime.getURL('src/offscreen/'))) {
    webrtc.attach(port);
    scheduleTransportIdleStop(); // e.g. worker restarted with no Meet call open
  }
});

function onMeetPort(port) {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined || port.sender?.frameId !== 0) { port.disconnect(); return; }
  const old = tabs.get(tabId);
  if (old) { endSession(old, 'content script replaced'); try { old.port.disconnect(); } catch { /* ignore */ } }
  /** @type {TabEntry} */
  const entry = {
    tabId, port, pageId: null, session: null, crypto: null, device: null,
    rx: Promise.resolve(), tx: Promise.resolve(),
  };
  tabs.set(tabId, entry);
  port.onMessage.addListener((msg) => {
    try { onContentMessage(entry, msg); } catch (err) { console.error('HotMic content message error', err); }
  });
  port.onDisconnect.addListener(() => {
    if (tabs.get(tabId) !== entry) return;
    endSession(entry, 'Meet tab closed');
    tabs.delete(tabId);
    pushPopups(tabId);
  });
  settingsReady.then(() => post(entry, { type: 'config', config: contentConfig(), settings }));
}

function onContentMessage(entry, msg) {
  if (!msg || typeof msg !== 'object') return;
  const s = entry.session;
  switch (msg.type) {
    case 'hello': entry.pageId = typeof msg.pageId === 'string' ? msg.pageId : null; break;
    case 'meet': onMeetState(entry, msg); break;
    case 'mic-result': s?.onMicCommandResult({ id: msg.id, ok: !!msg.ok, mic: msg.mic }); break;
    case 'key': if (msg.action === 'down' || msg.action === 'up') s?.onKey(msg.action, !!msg.repeat); break;
    case 'focus-lost': s?.onFocusLost(String(msg.reason || 'focus lost')); break;
    case 'activity': if (typeof msg.level === 'number') s?.onActivity(msg.level); break;
    case 'device': entry.device = sanitizeDevice(msg.device); s?.onDevice(entry.device); break;
    case 'action': doAction(entry, msg.action); break;
    default: break; // 'ping' keeps the worker alive
  }
}

function onMeetState(entry, msg) {
  const meetingId = parseMeetingId(String(msg.href || ''));
  const inCall = !!msg.inCall && !!meetingId;
  const mic = ['MUTED', 'UNMUTED', 'UNKNOWN'].includes(msg.mic) ? msg.mic : 'UNKNOWN';
  if (entry.session && (!inCall || entry.session.meetingId !== meetingId)) {
    endSession(entry, inCall ? 'meeting changed' : 'left the meeting');
  }
  if (inCall && !entry.session) startSession(entry, meetingId, mic);
  else if (entry.session) entry.session.onMeetState(mic, msg.cause === 'command' ? 'command' : msg.cause === 'initial' ? 'initial' : 'external');
}

function startSession(entry, meetingId, mic) {
  const session = new RoomSession({
    clock, config: CONFIG, meetingId,
    displayName: settings.displayName, mode: settings.mode,
    transportState: TRANSPORT.CONNECTING,
    send: (msg) => sendToRoom(entry, session, msg),
    sendMeetCommand: (cmd) => post(entry, { type: 'set-mute', id: cmd.id, muted: cmd.muted }),
    onChange: (snap) => {
      post(entry, { type: 'state', snapshot: snap });
      pushPopups(entry.tabId);
      updateBadge(entry.tabId, snap);
    },
    onPersist: ({ participation }) => persistConsent(entry, meetingId, participation),
  });
  entry.session = session;
  entry.crypto = null;
  clearTimeout(transportIdleTimer);
  syncRooms();
  transport.start();
  getRoomCrypto(meetingId).then((c) => {
    if (entry.session !== session) return;
    entry.crypto = c;
    applyTransport(entry);
  }).catch((err) => console.error('HotMic key derivation failed', err));
  session.start(mic);
  if (entry.device) session.onDevice(entry.device);
  applyTransport(entry);
  restoreConsent(entry, session, meetingId);
}

function endSession(entry, reason) {
  const s = entry.session;
  if (!s) return;
  s.dispose(reason);
  entry.session = null;
  entry.crypto = null;
  chrome.storage.session.remove(consentKey(entry.tabId)).catch(() => {});
  updateBadge(entry.tabId, null);
  syncRooms();
  scheduleTransportIdleStop();
}

/** Meetings the WebRTC mesh should be in (one mesh per meeting, shared by tabs). */
function syncRooms() {
  webrtc.setRooms([...tabs.values()].filter((e) => e.session).map((e) => e.session.meetingId));
}

function scheduleTransportIdleStop() {
  if ([...tabs.values()].some((e) => e.session)) return;
  clearTimeout(transportIdleTimer);
  transportIdleTimer = setTimeout(() => {
    if (![...tabs.values()].some((e) => e.session)) transport.stop();
  }, 30000);
}

function doAction(entry, action) {
  const s = entry?.session;
  if (!s) return;
  if (action === 'join') s.join();
  else if (action === 'decline') s.decline();
  else if (action === 'leave') s.leaveSharing();
  else if (action === 'toggle') s.uiToggle();
}

function post(entry, msg) {
  try { entry.port.postMessage(msg); } catch { /* port gone */ }
}

// ---------------------------------------------------------------------------
// Consent survives a service-worker restart within the same page instance only
// (not a refresh, not a new meeting): new page => new pageId => prompt again.

const consentKey = (tabId) => `consent:${tabId}`;

function persistConsent(entry, meetingId, participation) {
  chrome.storage.session.set({ [consentKey(entry.tabId)]: { meetingId, pageId: entry.pageId, participation } }).catch(() => {});
}

async function restoreConsent(entry, session, meetingId) {
  const key = consentKey(entry.tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored || entry.session !== session) return;
  if (stored.meetingId !== meetingId || !entry.pageId || stored.pageId !== entry.pageId) {
    await chrome.storage.session.remove(key);
    return;
  }
  if (stored.participation === 'SHARING_JOINED') session.join();
  else if (stored.participation === 'SHARING_DECLINED') session.decline();
}

// ---------------------------------------------------------------------------
// Transport + crypto

function getRoomCrypto(meetingId) {
  if (!roomCrypto.has(meetingId)) roomCrypto.set(meetingId, deriveRoom(meetingId));
  return roomCrypto.get(meetingId);
}

function applyTransport(entry) {
  if (!entry.session) return;
  let state = transport.state;
  if (state === 'idle') state = TRANSPORT.CONNECTING;
  if (state === 'up' && !entry.crypto) state = TRANSPORT.CONNECTING;
  entry.session.setTransportState(state);
}

function sendToRoom(entry, session, msg) {
  // Capture the key now: a disposing session's final release/leave must still go out
  // even though endSession() clears entry.crypto right after.
  const rc = entry.session === session ? entry.crypto : null;
  if (!rc) return;
  entry.tx = entry.tx.then(async () => {
    const data = await rc.seal(msg);
    transport.send(data);
    // The helper drops its own multicast echo, so other tabs of this browser in the
    // same meeting are served locally.
    if (transport.state === 'up' && [...tabs.values()].some((e) => e !== entry && e.crypto?.roomTag === rc.roomTag)) {
      route(data, entry);
    }
  }).catch(() => {});
}

function route(data, except = null) {
  let env;
  try { env = JSON.parse(data); } catch { return; }
  if (!env || typeof env.r !== 'string') return;
  for (const entry of tabs.values()) {
    if (entry === except) continue;
    const { session, crypto: rc } = entry;
    if (!session || !rc || rc.roomTag !== env.r) continue;
    entry.rx = entry.rx.then(async () => {
      const msg = await rc.open(env);
      if (msg && entry.session === session) session.receive(msg);
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Popup

function onPopupPort(port) {
  let tabId = null;
  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'subscribe' && Number.isInteger(msg.tabId)) {
      if (tabId !== null) popups.get(tabId)?.delete(port);
      tabId = msg.tabId;
      if (!popups.has(tabId)) popups.set(tabId, new Set());
      popups.get(tabId).add(port);
      await settingsReady;
      pushPopup(port, tabId);
    } else if (msg.type === 'action' && tabId !== null) {
      doAction(tabs.get(tabId), msg.action);
      pushPopups(tabId);
    } else if (msg.type === 'settings') {
      await updateSettings(msg.patch);
    }
  });
  port.onDisconnect.addListener(() => { if (tabId !== null) popups.get(tabId)?.delete(port); });
}

function pushPopup(port, tabId) {
  const entry = tabs.get(tabId);
  try {
    port.postMessage({
      type: 'state',
      tabId,
      hasContentScript: !!entry,
      snapshot: entry?.session ? entry.session.snapshot() : null,
      settings,
      transport: {
        state: transport.state,
        helper: { state: native.state, error: native.lastError, info: native.helperInfo },
        webrtc: webrtc.info(),
      },
    });
  } catch { /* closed */ }
}

function pushPopups(tabId) { for (const p of popups.get(tabId) || []) pushPopup(p, tabId); }
function pushAllPopups() { for (const tabId of popups.keys()) pushPopups(tabId); }

function updateBadge(tabId, snap) {
  const owner = snap && snap.ownership.ownerIsSelf && snap.ownership.state === 'OWNER';
  const joined = snap && snap.participation === 'SHARING_JOINED';
  chrome.action.setBadgeText({ tabId, text: owner ? 'MIC' : joined ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: owner ? '#188038' : '#5f6368' }).catch(() => {});
}

/** '' (off) or a plain http(s) origin/path without credentials; null = invalid. */
function sanitizeDiscoveryUrl(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (v.length > 200) return null;
  try {
    const u = new URL(v);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    return u.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function sanitizeDevice(d) {
  if (!d || typeof d !== 'object') return null;
  return {
    label: sanitizeName(String(d.label || 'Microphone'), 80),
    available: d.available !== false,
    readyState: d.readyState === 'ended' ? 'ended' : 'live',
    trackMuted: !!d.trackMuted,
  };
}

// ---------------------------------------------------------------------------
// Extension install/update/reload: existing Meet tabs don't get content scripts
// automatically, so inject them (orphaned old scripts mute and tear down).

chrome.runtime.onInstalled.addListener(async () => {
  const meetTabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
  for (const t of meetTabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, world: 'MAIN', files: ['src/content/page-probe.js'] });
      await chrome.scripting.executeScript({
        target: { tabId: t.id },
        files: ['src/content/meet-adapter.js', 'src/content/overlay.js', 'src/content/content.js'],
      });
    } catch { /* tab not scriptable */ }
  }
});

/**
 * @typedef {object} TabEntry
 * @property {number} tabId
 * @property {chrome.runtime.Port} port
 * @property {string|null} pageId
 * @property {RoomSession|null} session
 * @property {import('./crypto.js').RoomCrypto|null} crypto
 * @property {object|null} device
 * @property {Promise<void>} rx
 * @property {Promise<void>} tx
 */
