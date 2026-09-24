// Real two-browser WebRTC discovery test (dev tool, not part of `npm test`).
//
// Starts a local rendezvous server and two independent Chrome instances (two
// "laptops"), each with its own profile + this extension and no native
// helper. Both open the same fake Meet call. Checks: master election,
// nearby prompt, joining, PTT ownership across browsers, handover, and that
// only one master registered at the server.
//
// Usage: node tools/browser-webrtc-smoke.mjs [--builtin] ["path/to/chrome"]
//   --builtin: use the built-in PeerJS cloud instead of a local rendezvous server.

import { createServer } from '../rendezvous/server.mjs';
import { RendezvousStore } from '../rendezvous/store.mjs';
import { launch, findChrome, waitUntil, sleep, checker } from './lib/chrome.mjs';

const CHROME = findChrome(process.argv[2]);
if (!CHROME) { console.error('Chrome not found'); process.exit(2); }
const { check, summary } = checker();

// --builtin: use the built-in PeerJS cloud (no local server, real internet).
const BUILTIN = process.argv.includes('--builtin');
let server = null;
let store = null;
let url = '';
if (!BUILTIN) {
  store = new RendezvousStore();
  server = createServer({ store, rateLimit: { perSec: 200, burst: 400 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
}
const MEETING = 'abc-defg-hij';

const text = (b, s, id) => b.eval(s, `document.getElementById('${id}')?.textContent || ''`);
let A; let B;
try {
  [A, B] = await Promise.all([launch(CHROME), launch(CHROME)]);
  check('two independent Chrome instances with the extension', true);

  // --- Laptop A: Sahil, joins alone first
  const meetA = await A.openFakeMeet(MEETING);
  const popA = await A.openPopup();
  await A.setField(popA.sessionId, 'display-name', 'Sahil');
  if (!BUILTIN) await A.setField(popA.sessionId, 'discovery-url', url);
  await A.eval(popA.sessionId, `document.getElementById('join').click()`);
  const aPath = await waitUntil(async () => { const t = await text(A, popA.sessionId, 'paths'); return /WebRTC[^:]*: connected · master/.test(t) && t; }, 'A master', 15000).catch(() => false);
  check('first device becomes the WebRTC master (helper not installed)', !!aPath, aPath || await text(A, popA.sessionId, 'paths'));
  check('A status is Connected (not "Local only")', /^Connected/.test(await text(A, popA.sessionId, 'status')), await text(A, popA.sessionId, 'status'));

  // --- Laptop B: Samir, listens first, finds A's master, gets prompted
  const meetB = await B.openFakeMeet(MEETING);
  const popB = await B.openPopup();
  await B.setField(popB.sessionId, 'display-name', 'Samir');
  if (!BUILTIN) await B.setField(popB.sessionId, 'discovery-url', url);
  const prompt = await waitUntil(async () => {
    const t = await text(B, popB.sessionId, 'prompt-text');
    return t.includes('Sahil is nearby') && t;
  }, 'B prompt', 20000).catch(() => false);
  check('B discovers A over WebRTC and is prompted', !!prompt, prompt || await text(B, popB.sessionId, 'paths'));
  const bPath = await text(B, popB.sessionId, 'paths');
  check('B joined the mesh as a member (not a second master)', /WebRTC[^:]*: connected · 1 nearby link/.test(bPath) && !/master/.test(bPath), bPath);
  if (!BUILTIN) check('server has exactly one master for the room', [...store.rooms.values()].reduce((n, r) => n + r.masters.size, 0) === 1);

  await B.eval(popB.sessionId, `document.getElementById('join').click()`);
  const bothListed = await waitUntil(async () => {
    const t = await text(A, popA.sessionId, 'participants');
    return t.includes('Samir') && t;
  }, 'A sees Samir joined', 10000).catch(() => false);
  check('A sees B as a sharing participant', !!bothListed, bothListed || '');
  check('both muted after joining', (await A.micMuted(meetA)) && (await B.micMuted(meetB)));
  await sleep(2000); // sync window

  // --- A takes the mic (PTT)
  await A.key(meetA, 'rawKeyDown');
  const aUnmuted = await waitUntil(async () => !(await A.micMuted(meetA)), 'A unmuted', 5000).catch(() => false);
  check('A holds PTT => A unmuted in Meet', aUnmuted);
  check('B stays muted', await B.micMuted(meetB));
  const bOwner = await waitUntil(async () => { const t = await text(B, popB.sessionId, 'owner-line'); return t.startsWith('Sahil has the microphone') && t; }, 'B sees owner', 5000).catch(() => false);
  check('B popup: "Sahil has the microphone · Ns"', !!bOwner, bOwner || await text(B, popB.sessionId, 'owner-line'));

  // --- B requests during A's first 5 s: nothing changes; A releases => B gets it
  await B.key(meetB, 'rawKeyDown');
  await sleep(1000);
  check('B request within A\'s 5 s minimum does not transfer', (await B.micMuted(meetB)) && !(await A.micMuted(meetA)));
  await A.key(meetA, 'keyUp');
  const handover = await waitUntil(async () => (await A.micMuted(meetA)) && !(await B.micMuted(meetB)), 'handover', 6000).catch(() => false);
  check('A releases => mic handed to waiting B; A muted first', handover);
  const aOwner = await waitUntil(async () => { const t = await text(A, popA.sessionId, 'owner-line'); return t.startsWith('Samir has the microphone') && t; }, 'A sees B owner', 5000).catch(() => false);
  check('A popup shows Samir has the microphone', !!aOwner, aOwner || '');
  await B.key(meetB, 'keyUp');
  await waitUntil(async () => (await A.micMuted(meetA)) && (await B.micMuted(meetB)), 'all muted', 5000).catch(() => false);
  check('B releases => everyone muted, microphone available',
    (await A.micMuted(meetA)) && (await B.micMuted(meetB)) && (await text(A, popA.sessionId, 'owner-line')) === 'Microphone available');

  // --- Server-blindness (custom-server mode only; the built-in cloud check is
  // covered by mesh unit tests and the peerjs-probe tool)
  if (!BUILTIN) {
    const blobs = JSON.stringify([...store.rooms.values()].map((r) => [...r.inboxes.values()].map((b) => b.queue)));
    check('server never saw names or meeting code', !/Sahil|Samir|abc-defg-hij/.test(blobs) && ![...store.rooms.keys()].some((k) => k.includes('abc')));
  }
} catch (err) {
  check(`run: ${err.message}`, false);
} finally {
  await Promise.all([A?.close(), B?.close()]);
  if (server) { server.closeAllConnections?.(); server.close(); }
}
process.exit(summary() ? 1 : 0);
