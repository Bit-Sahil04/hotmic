// Dev probe: verify the real PeerJS cloud works from a real Chrome (as the
// extension's offscreen document would use it), and capture the raw wire
// protocol for the hand-rolled client. Usage: node tools/peerjs-probe.mjs
import { launch, findChrome, ROOT, sleep } from './lib/chrome.mjs';

const PAGE = `<!doctype html><body><script src="/vendor/peerjs.min.js"></script><script>
window.out = [];
const log = (...a) => window.out.push(a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
(async () => {
  try {
    const idA = hex(16); const idR = hex(16);
    log('A=' + idA + ' RAW=' + idR);
    const a = new Peer(idA, { config: { iceServers: [] } });
    a.on('open', () => log('A open'));
    a.on('error', (e) => log('A error:', e.type, (e.message || '').slice(0, 120)));
    a.on('connection', (c) => { log('A got connection from', c.peer, 'meta:', JSON.stringify(c.metadata)); });
    await new Promise((r) => a.on('open', r));
    await sleep(300);
    // RAW socket sends an OFFER addressed to the real client A
    const raw = await new Promise((resolve, reject) => {
      const ws = new WebSocket('wss://0.peerjs.com:443/peerjs?key=peerjs&id=' + idR + '&token=' + Math.random().toString(36).slice(2) + '&version=1.5.4');
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error('ws error'));
    });
    raw.onmessage = (ev) => log('RAW < ' + ev.data.slice(0, 150));
    raw.onclose = (e) => log('RAW close code=' + e.code);
    await sleep(300);
    log('RAW sends OFFER dst=A');
    raw.send(JSON.stringify({ type: 'OFFER', payload: { sdp: { sdp: 'x', type: 'offer' }, type: 'data', connectionId: 'dc_x1', metadata: { blob: 'sealed' }, label: 'l', reliable: false, serialization: 'binary' }, dst: idA }));
    await sleep(3000);
    log('RAW alive=' + (raw.readyState === 1) + ' A alive=' + (a.open));
    log('PROBE-DONE');
  } catch (e) { log('PROBE-FAIL ' + (e.stack || e.message)); }
})();
</script></body>`;

const chrome = findChrome(process.argv[2]);
const b = await launch(chrome, { headless: true });
try {
  const tab = await b.openTab(null);
  b.listeners.push(async (m) => {
    if (m.method === 'Fetch.requestPaused' && m.sessionId === tab.sessionId) {
      const u = m.params.request.url;
      const body = u.endsWith('/peerjs.min.js')
        ? (await import('node:fs')).readFileSync(ROOT + '/vendor/peerjs.min.js')
        : Buffer.from(PAGE);
      await b.cdp('Fetch.fulfillRequest', {
        requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: u.endsWith('.js') ? 'text/javascript' : 'text/html' }],
        body: body.toString('base64'),
      }, tab.sessionId).catch(() => {});
    }
  });
  await b.cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://probe.test/*', requestStage: 'Request' }] }, tab.sessionId);
  await b.cdp('Page.navigate', { url: 'https://probe.test/main' }, tab.sessionId);
  let out = '';
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    out = await b.eval(tab.sessionId, `window.out.join('\n')`).catch(() => '');
    if (out.includes('PROBE-DONE') || out.includes('PROBE-FAIL')) break;
  }
  console.log(await b.eval(tab.sessionId, `JSON.stringify(window.out)`).catch(() => '[]'));
  const frames = await b.eval(tab.sessionId, `JSON.stringify(window.frames)`).catch(() => '[]');
  for (const f of JSON.parse(frames || '[]')) console.log(f.dir, f.url || f.data || '');
} finally { await b.close(); }
