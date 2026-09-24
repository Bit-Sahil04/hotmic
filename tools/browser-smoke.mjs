// Real-browser smoke test (dev tool, not part of `npm test`).
//
// Launches Chrome with a throw-away profile + this unpacked extension, serves a
// fake Google Meet call page at https://meet.google.com/abc-defg-hij via CDP
// request interception, then drives: content script -> service worker ->
// popup (join) -> PTT key -> Meet mic toggled -> release.
// Runs in local-only mode (no native helper needed).
//
// Usage: node tools/browser-smoke.mjs ["path/to/chrome"]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_ID = 'ijjmpbibipdmmloibgobofjoindgplop';
const CANDIDATES = [
  process.argv[2],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.error('Chrome not found'); process.exit(2); }

const FAKE_MEET = `<!doctype html><html><head><title>Meet</title></head><body>
<div id="tile" data-participant-id="spaces/x/devices/1">tile</div>
<div role="button" id="mic" data-is-muted="false" aria-label="Turn off microphone (ctrl + d)">mic</div>
<div role="button" id="cam" data-is-muted="true" aria-label="Turn on camera (ctrl + e)">cam</div>
<button jsname="CQylAd" aria-label="Leave call">leave</button>
<input id="chat" placeholder="chat">
<script>
  window.meetSpaceHandled = 0;
  document.addEventListener('keydown', (e) => { if (e.code === 'Space') window.meetSpaceHandled++; });
  const mic = document.getElementById('mic');
  mic.addEventListener('click', () => {
    const muted = mic.getAttribute('data-is-muted') === 'true';
    mic.setAttribute('data-is-muted', String(!muted));
    mic.setAttribute('aria-label', muted ? 'Turn off microphone (ctrl + d)' : 'Turn on microphone (ctrl + d)');
  });
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), 'hotmic-smoke-'));
const chrome = spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--headless=new',
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', 'about:blank',
], { stdio: 'ignore' });

let ws; let nextId = 1; const pending = new Map(); const listeners = [];
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}
const onEvent = (fn) => listeners.push(fn);

async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`);
  return r.result.value;
}

async function waitUntil(fn, what, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

try {
  const version = await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), 'devtools');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
    } else if (msg.method) listeners.forEach((fn) => fn(msg));
  });

  // 1. Load the unpacked extension (Chrome 137+ ignores --load-extension) and
  //    check its service worker is up (module graph loaded without errors).
  const loaded = await cdp('Extensions.loadUnpacked', { path: ROOT });
  check('unpacked extension loads with the pinned id', loaded.id === EXT_ID, loaded.id);
  const sw = await waitUntil(async () => (await cdp('Target.getTargets')).targetInfos
    .find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT_ID}/`)), 'service worker');
  check('extension loaded with pinned id + service worker running', !!sw, sw.url);

  // 2. Fake Meet call tab, served through request interception.
  const { targetId: meetTarget } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { sessionId: meet } = await cdp('Target.attachToTarget', { targetId: meetTarget, flatten: true });
  onEvent(async (m) => {
    if (m.method === 'Fetch.requestPaused' && m.sessionId === meet) {
      await cdp('Fetch.fulfillRequest', {
        requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from(FAKE_MEET).toString('base64'),
      }, meet).catch(() => {});
    }
  });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://meet.google.com/*', requestStage: 'Request' }] }, meet);
  await cdp('Runtime.enable', {}, meet);
  await cdp('Page.enable', {}, meet);
  await cdp('Page.navigate', { url: 'https://meet.google.com/abc-defg-hij' }, meet);
  await waitUntil(() => evaluate(meet, `document.readyState === 'complete' && !!document.getElementById('hotmic-overlay-host')`), 'content script overlay');
  check('content script injected into Meet page (overlay host present)', true);
  check('page probe installed in MAIN world', await evaluate(meet, `window.__hotmicProbeInstalled === true`));

  // 3. Popup (opened as a tab for the Meet tab) shows the meeting; join alone.
  const { targetId: popTarget } = await cdp('Target.createTarget', { url: `chrome-extension://${EXT_ID}/src/popup/popup.html` });
  const { sessionId: pop } = await cdp('Target.attachToTarget', { targetId: popTarget, flatten: true });
  await waitUntil(() => evaluate(pop, `!!globalThis.chrome?.tabs`), 'popup');
  const tabId = await evaluate(pop, `chrome.tabs.query({url:'https://meet.google.com/*'}).then(t => t[0].id)`);
  await cdp('Page.navigate', { url: `chrome-extension://${EXT_ID}/src/popup/popup.html?tabId=${tabId}` }, pop);
  const meetingText = await waitUntil(() => evaluate(pop, `document.getElementById('meeting-id')?.textContent`), 'popup meeting id');
  check('meeting detected + id extracted', meetingText === 'abc-defg-hij', meetingText);
  // This scenario is local-only: turn the built-in WebRTC discovery off first.
  await evaluate(pop, `(() => { const el = document.getElementById('discovery-url'); el.value = 'off'; el.dispatchEvent(new Event('change')); })()`);
  await waitUntil(() => evaluate(pop, `document.getElementById('discovery-url-error').hidden`), 'discovery setting');
  let statusText = '';
  await waitUntil(async () => {
    statusText = await evaluate(pop, `document.getElementById('status').textContent`);
    return /Local only/.test(statusText);
  }, 'local-only status').catch(() => {});
  check('local-only mode when LAN helper is not installed', /Local only/.test(statusText), statusText);

  await evaluate(pop, `document.getElementById('join').click()`);
  await waitUntil(() => evaluate(pop, `document.getElementById('sharing-status').textContent.includes('Sharing enabled')`), 'joined');
  check('user can join alone', true);
  const mutedOnJoin = await waitUntil(() => evaluate(meet, `document.getElementById('mic').getAttribute('data-is-muted') === 'true'`), 'mute on join');
  check('joining mutes Meet (no owner yet)', mutedOnJoin);
  const alone = await evaluate(pop, `!document.getElementById('alone').hidden`);
  check('popup shows "No other participants nearby"', alone);

  // 4. PTT: space down => extension clicks Meet's mic => unmuted; Meet's own handler suppressed.
  await cdp('Target.activateTarget', { targetId: meetTarget });
  await evaluate(meet, `window.focus()`);
  const key = (type) => cdp('Input.dispatchKeyEvent', { type, code: 'Space', key: ' ', windowsVirtualKeyCode: 32 }, meet);
  await key('rawKeyDown');
  const unmuted = await waitUntil(() => evaluate(meet, `document.getElementById('mic').getAttribute('data-is-muted') === 'false'`), 'unmute via PTT', 4000).catch(() => false);
  check('PTT press acquires mic and unmutes Meet', !!unmuted);
  check("Meet's own Space handler suppressed", (await evaluate(meet, 'window.meetSpaceHandled')) === 0);
  const ownerLine = await evaluate(pop, `document.getElementById('owner-line').textContent`);
  check('popup: "You have the microphone · Ns"', /^You have the microphone · \d+s$/.test(ownerLine), ownerLine);
  await key('keyUp');
  const remuted = await waitUntil(() => evaluate(meet, `document.getElementById('mic').getAttribute('data-is-muted') === 'true'`), 'mute on release', 4000).catch(() => false);
  check('PTT release mutes Meet and releases ownership', !!remuted);
  await sleep(300);
  check('popup: "Microphone available"', (await evaluate(pop, `document.getElementById('owner-line').textContent`)) === 'Microphone available');

  // 5. Manual unmute by a non-owner is reverted.
  await evaluate(meet, `document.getElementById('mic').click()`);
  const reverted = await waitUntil(() => evaluate(meet, `document.getElementById('mic').getAttribute('data-is-muted') === 'true'`), 'revert manual unmute', 4000).catch(() => false);
  check('manual unmute without ownership is reverted', !!reverted);

  // 6. Leaving the call ends the session.
  await evaluate(meet, `document.querySelector('[jsname=CQylAd]').remove(); document.getElementById('tile').remove(); document.getElementById('mic').remove(); document.getElementById('cam').remove();`);
  const ended = await waitUntil(() => evaluate(pop, `!document.getElementById('no-meet').hidden`), 'session end', 6000).catch(() => false);
  check('leaving the call cleans up the session', !!ended);
} catch (err) {
  check(`smoke run: ${err.message}`, false);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
