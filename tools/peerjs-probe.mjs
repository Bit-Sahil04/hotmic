// Dev probe: verify the real PeerJS cloud works from a real Chrome (as the
// extension's offscreen document would use it), and capture the raw wire
// protocol for the hand-rolled client. Usage: node tools/peerjs-probe.mjs
import { launch, findChrome, ROOT, sleep } from './lib/chrome.mjs';

const PAGE = `<!doctype html><body><script src="/vendor/peerjs.min.js"></script><script>
window.out = [];
const log = (...a) => window.out.push(a.join(' '));
const TAG = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
(async () => {
  try {
    const master = new Peer('h' + TAG, { debug: 0 });
    await new Promise((r, j) => { master.on('open', r); master.on('error', (e) => j(new Error(e.type))); });
    const seen = [];
    master.socket.on('message', (f) => { seen.push(f.type); log('MASTER < ' + f.type + ' src=' + f.src + ' payload=' + JSON.stringify(f.payload).slice(0, 70)); });
    master.on('connection', (c) => log('MASTER conn from ' + c.peer));
    master.on('error', (e) => log('MASTER error: ' + e.type));
    const member = new Peer('m' + hex(16), { debug: 0 });
    await new Promise((r) => member.on('open', r));
    member.on('error', (e) => log('MEMBER error: ' + e.type));
    const slot = 'h' + TAG;
    const trials = [
      ['OFFER-garbage', { type: 'OFFER', payload: { sdp: 'GARBAGE', type: 'data', connectionId: 'dc_t1' }, dst: slot }],
      ['OFFER-shape',   { type: 'OFFER', payload: { sdp: { type: 'offer', sdp: 'v=0' }, type: 'data', connectionId: 'dc_t2' }, dst: slot }],
      ['ANSWER-garbage',{ type: 'ANSWER', payload: { sdp: 'GARBAGE', type: 'data', connectionId: 'dc_t3' }, dst: slot }],
      ['CANDIDATE',     { type: 'CANDIDATE', payload: { candidate: { sdpMid: '0' }, connectionId: 'dc_t4' }, dst: slot }],
      ['X-again',       { type: 'X', payload: { data: 'blob' }, dst: slot }],
    ];
    for (const [name, frame] of trials) {
      member.socket.send(frame);
      await new Promise((r) => setTimeout(r, 700));
      log(name + ': member socket still open=' + (member.socket._ws?.readyState === 1) + ' relayed=' + seen.length);
    }
    log('PROBE-DONE');
  } catch (e) { log('PROBE-FAIL ' + (e.message || e)); }
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
