// Minimal Chrome/CDP harness for the smoke tests (no dependencies).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXT_ID = 'ijjmpbibipdmmloibgobofjoindgplop';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome(explicit) {
  return [
    explicit,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean).find((p) => existsSync(p));
}

export const FAKE_MEET = `<!doctype html><html><head><title>Meet</title></head><body>
<div id="tile" data-participant-id="spaces/x/devices/1">tile</div>
<div role="button" id="mic" data-is-muted="false" aria-label="Turn off microphone (ctrl + d)">mic</div>
<div role="button" id="cam" data-is-muted="true" aria-label="Turn on camera (ctrl + e)">cam</div>
<button jsname="CQylAd" aria-label="Leave call">leave</button>
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

export async function waitUntil(fn, what, ms = 8000) {
  const start = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); } catch (err) { last = undefined; }
    if (last) return last;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(150);
  }
}

/** Launch Chrome with a throw-away profile and load the unpacked extension. */
export async function launch(chromePath, { headless = true } = {}) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(path.join(tmpdir(), 'hotmic-smoke-'));
  const proc = spawn(chromePath, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
    ...(headless ? ['--headless=new'] : []),
    '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging', 'about:blank',
  ], { stdio: 'ignore' });
  const version = await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), 'devtools', 15000);
  const b = new Browser(new WebSocket(version.webSocketDebuggerUrl), proc, profile);
  await b.ready;
  const loaded = await b.cdp('Extensions.loadUnpacked', { path: ROOT });
  if (loaded.id !== EXT_ID) throw new Error(`unexpected extension id ${loaded.id}`);
  return b;
}

class Browser {
  constructor(ws, proc, profile) {
    this.ws = ws; this.proc = proc; this.profile = profile;
    this.nextId = 1; this.pending = new Map(); this.listeners = [];
    this.ready = new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`)); else p.resolve(msg.result);
      } else if (msg.method) this.listeners.forEach((fn) => fn(msg));
    });
  }

  cdp(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  async eval(sessionId, expression) {
    const r = await this.cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`${expression}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  async openTab(url) {
    const { targetId } = await this.cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp('Target.attachToTarget', { targetId, flatten: true });
    await this.cdp('Runtime.enable', {}, sessionId);
    await this.cdp('Page.enable', {}, sessionId);
    if (url) await this.cdp('Page.navigate', { url }, sessionId);
    return { targetId, sessionId };
  }

  /** A fake Meet call page at https://meet.google.com/<code>, served via request interception. */
  async openFakeMeet(code) {
    const tab = await this.openTab(null);
    this.listeners.push(async (m) => {
      if (m.method === 'Fetch.requestPaused' && m.sessionId === tab.sessionId) {
        await this.cdp('Fetch.fulfillRequest', {
          requestId: m.params.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          body: Buffer.from(FAKE_MEET).toString('base64'),
        }, tab.sessionId).catch(() => {});
      }
    });
    await this.cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://meet.google.com/*', requestStage: 'Request' }] }, tab.sessionId);
    await this.cdp('Page.navigate', { url: `https://meet.google.com/${code}` }, tab.sessionId);
    await waitUntil(() => this.eval(tab.sessionId, `document.readyState === 'complete' && !!document.getElementById('hotmic-overlay-host')`), 'content script');
    return tab;
  }

  /** The extension popup opened as a tab, bound to the (single) Meet tab. */
  async openPopup() {
    const tab = await this.openTab(`chrome-extension://${EXT_ID}/src/popup/popup.html`);
    await waitUntil(() => this.eval(tab.sessionId, `!!globalThis.chrome?.tabs`), 'popup');
    const tabId = await this.eval(tab.sessionId, `chrome.tabs.query({url:'https://meet.google.com/*'}).then(t => t[0].id)`);
    await this.cdp('Page.navigate', { url: `chrome-extension://${EXT_ID}/src/popup/popup.html?tabId=${tabId}` }, tab.sessionId);
    await waitUntil(() => this.eval(tab.sessionId, `document.getElementById('meeting-id')?.textContent`), 'popup meeting');
    return tab;
  }

  async setField(sessionId, id, value) {
    await this.eval(sessionId, `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); })()`);
  }

  async key(tab, type, code = 'Space') {
    await this.cdp('Target.activateTarget', { targetId: tab.targetId });
    await this.cdp('Input.dispatchKeyEvent', { type, code, key: code === 'Space' ? ' ' : code, windowsVirtualKeyCode: 32 }, tab.sessionId);
  }

  micMuted(tab) { return this.eval(tab.sessionId, `document.getElementById('mic').getAttribute('data-is-muted') === 'true'`); }

  async close() {
    try { this.ws.close(); } catch { /* ignore */ }
    this.proc.kill();
    await sleep(700);
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function checker() {
  const results = [];
  const check = (name, ok, extra = '') => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  };
  const summary = () => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    return failed;
  };
  return { check, summary };
}
