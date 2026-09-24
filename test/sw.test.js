// Smoke test of the service-worker glue with a mocked `chrome` API:
// content port -> session -> Meet commands, popup port, local-only fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function event() {
  const ls = [];
  return { addListener: (f) => ls.push(f), removeListener: (f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); }, fire: (...a) => ls.forEach((f) => f(...a)) };
}

function makePortPair(name, sender) {
  const ext = { name, sender, onMessage: event(), onDisconnect: event(), sent: [], postMessage(m) { this.sent.push(structuredClone(m)); }, disconnect() {} };
  return ext;
}

function installChromeMock() {
  const store = { local: {}, session: {} };
  const area = (k) => ({
    get: async (key) => (typeof key === 'string' ? { [key]: store[k][key] } : { ...store[k] }),
    set: async (obj) => { Object.assign(store[k], structuredClone(obj)); },
    remove: async (key) => { delete store[k][key]; },
  });
  const chrome = {
    runtime: {
      onConnect: event(), onInstalled: event(), lastError: null,
      connectNative() {
        const p = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} };
        setTimeout(() => { chrome.runtime.lastError = { message: 'Specified native messaging host not found.' }; p.onDisconnect.fire(); chrome.runtime.lastError = null; }, 5);
        return p;
      },
    },
    storage: { local: area('local'), session: area('session') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => {} },
    offscreen: {
      created: [], closed: 0,
      async createDocument(opts) { if (this.created.length > this.closed) throw new Error('Only a single offscreen document may be created.'); this.created.push(opts); },
      async closeDocument() { this.closed++; },
    },
  };
  chrome.runtime.getURL = (path) => `chrome-extension://test/${path}`;
  globalThis.chrome = chrome;
  // Long service-worker timers (transport retry / idle stop) must not keep the test process alive.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => { const t = realSetTimeout(fn, ms, ...a); if (ms >= 1000) t.unref?.(); return t; };
  return chrome;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const last = (port, type) => port.sent.filter((m) => m.type === type).at(-1);

test('service worker: Meet tab session, local-only join, PTT command round-trip, popup, cleanup', async () => {
  const chrome = installChromeMock();
  await import('../src/background/service-worker.js');

  const meet = makePortPair('hotmic-meet', { tab: { id: 7 }, frameId: 0 });
  chrome.runtime.onConnect.fire(meet);
  meet.onMessage.fire({ type: 'hello', pageId: 'p1' });
  meet.onMessage.fire({ type: 'meet', href: 'https://meet.google.com/abc-defg-hij', inCall: true, mic: 'MUTED', cause: 'initial' });
  await sleep(100); // helper "not found" => local-only
  assert.ok(last(meet, 'config'), 'config pushed to content script');
  const st = last(meet, 'state').snapshot;
  assert.equal(st.meetingId, 'abc-defg-hij');
  assert.equal(st.transport, 'unavailable');
  assert.equal(st.localOnly, true);

  const popup = makePortPair('hotmic-popup', {});
  chrome.runtime.onConnect.fire(popup);
  popup.onMessage.fire({ type: 'subscribe', tabId: 7 });
  await sleep(20);
  assert.equal(last(popup, 'state').snapshot.participation, 'IN_MEETING');

  popup.onMessage.fire({ type: 'action', action: 'join' });
  await sleep(20);
  assert.equal(last(meet, 'state').snapshot.participation, 'SHARING_JOINED');

  meet.onMessage.fire({ type: 'key', action: 'down', repeat: false });
  await sleep(150);
  const cmd = last(meet, 'set-mute');
  assert.equal(cmd.muted, false, 'unmute requested from Meet adapter');
  meet.onMessage.fire({ type: 'meet', href: 'https://meet.google.com/abc-defg-hij', inCall: true, mic: 'UNMUTED', cause: 'command' });
  meet.onMessage.fire({ type: 'mic-result', id: cmd.id, ok: true, mic: 'UNMUTED' });
  await sleep(20);
  const owned = last(meet, 'state').snapshot;
  assert.equal(owned.ownership.state, 'OWNER');
  assert.equal(owned.wantsActivity, true);

  popup.onMessage.fire({ type: 'settings', patch: { mode: 'toggle', pttKey: 'KeyT', displayName: '  Sahil\u0000 ' } });
  await sleep(50);
  const cfg = last(meet, 'config');
  assert.equal(cfg.settings.pttKey, 'KeyT');
  assert.equal(cfg.settings.displayName, 'Sahil');
  assert.equal(last(meet, 'state').snapshot.ownership.state === 'OWNER', false, 'mode switch releases the mic');

  // leaving the call ends the session and clears persisted consent
  meet.onMessage.fire({ type: 'meet', href: 'https://meet.google.com/abc-defg-hij', inCall: false, mic: 'UNKNOWN', cause: 'external' });
  await sleep(20);
  assert.equal(last(meet, 'state').snapshot.ended, true);
  assert.equal((await chrome.storage.session.get('consent:7'))['consent:7'], undefined);
  meet.onDisconnect.fire();
});

test('service worker: WebRTC discovery option — URL validation, offscreen mesh, status + data routing', async () => {
  const chrome = globalThis.chrome;
  const meet = makePortPair('hotmic-meet', { tab: { id: 8 }, frameId: 0 });
  chrome.runtime.onConnect.fire(meet);
  meet.onMessage.fire({ type: 'hello', pageId: 'p2' });
  meet.onMessage.fire({ type: 'meet', href: 'https://meet.google.com/xyz-abcd-efg', inCall: true, mic: 'MUTED', cause: 'initial' });
  await sleep(100);
  assert.equal(last(meet, 'state').snapshot.localOnly, true, 'neither helper nor discovery server => local only');

  const popup = makePortPair('hotmic-popup', {});
  chrome.runtime.onConnect.fire(popup);
  popup.onMessage.fire({ type: 'subscribe', tabId: 8 });
  popup.onMessage.fire({ type: 'settings', patch: { discoveryUrl: 'javascript:alert(1)' } });
  await sleep(30);
  assert.equal(last(popup, 'state').settings.discoveryUrl, '', 'non-http URL rejected');
  assert.equal(chrome.offscreen.created.length, 0);

  popup.onMessage.fire({ type: 'settings', patch: { discoveryUrl: ' http://localhost:8787/ ' } });
  await sleep(30);
  assert.equal(last(popup, 'state').settings.discoveryUrl, 'http://localhost:8787');
  assert.equal(chrome.offscreen.created.length, 1);
  assert.deepEqual(chrome.offscreen.created[0].reasons, ['WEB_RTC']);
  assert.equal(last(popup, 'state').transport.webrtc.state, 'connecting');

  // Offscreen document connects; must come from our offscreen page.
  const rogue = makePortPair('hotmic-offscreen', { url: 'https://evil.example/' });
  chrome.runtime.onConnect.fire(rogue);
  const off = makePortPair('hotmic-offscreen', { url: 'chrome-extension://test/src/offscreen/offscreen.html' });
  chrome.runtime.onConnect.fire(off);
  await sleep(10);
  assert.equal(rogue.sent.length, 0);
  assert.deepEqual(last(off, 'config'), { type: 'config', url: 'http://localhost:8787', rooms: ['xyz-abcd-efg'] });

  off.onMessage.fire({ type: 'status', rooms: { 'xyz-abcd-efg': { state: 'up', role: 'master', peers: 0, error: null } } });
  await sleep(1700);
  const snap = last(meet, 'state').snapshot;
  assert.equal(snap.transport, 'up');
  assert.equal(snap.localOnly, false);
  const w = last(popup, 'state').transport.webrtc;
  assert.equal(w.state, 'up');
  assert.equal(w.role, 'master');

  // Heartbeats go out through the offscreen mesh as sealed envelopes.
  const sent = off.sent.filter((m) => m.type === 'send');
  assert.ok(sent.length > 0, 'room traffic sent via WebRTC');
  assert.ok(JSON.parse(sent[0].data).p === 'hotmic' && !sent[0].data.includes('Sahil'), 'sealed, no plaintext');

  // Offscreen document crashes => lost => recreated.
  chrome.offscreen.closed++;
  off.onDisconnect.fire();
  await sleep(20);
  assert.equal(last(meet, 'state').snapshot.transport, 'lost');
  await sleep(1100);
  assert.equal(chrome.offscreen.created.length, 2, 'offscreen document recreated');
  meet.onDisconnect.fire();
});
