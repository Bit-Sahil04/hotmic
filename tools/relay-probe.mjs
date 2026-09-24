// Isolate what makes the cloud close the sender: control vs OFFER variants.
import { launch, findChrome, sleep } from './lib/chrome.mjs';

const PAGE = `<!doctype html><body><script>
window.out = [];
const log = (...a) => window.out.push(a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
let t0 = Date.now();
const ts = () => '+' + (Date.now() - t0) + 'ms';
function mksock(id, tag, beatMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://0.peerjs.com:443/peerjs?key=peerjs&id=' + id + '&token=' + Math.random().toString(36).slice(2) + '&version=1.5.4');
    ws.onopen = () => log(ts(), tag, 'open');
    ws.onmessage = (ev) => log(ts(), tag, '<', ev.data.slice(0, 250));
    ws.onclose = (e) => log(ts(), tag, 'close code=' + e.code);
    ws.addEventListener('open', () => {
      if (beatMs) ws._beat = setInterval(() => ws.send(JSON.stringify({ type: 'HEARTBEAT' })), beatMs);
      resolve(ws);
    }, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
}
(async () => {
  try {
    const dst = hex(16); const me = hex(16);
    const master = await mksock(dst, 'MASTER', 4000);
    const member = await mksock(me, 'MEMBER', 4000);
    await sleep(500);
    // EXACT key order of the real client: type, payload(sdp, type, connectionId, metadata, label, reliable, serialization), dst
    const frame = JSON.stringify({
      type: 'OFFER',
      payload: { sdp: { sdp: 'v=0', type: 'offer' }, type: 'data', connectionId: 'dc_' + hex(4), metadata: { blob: 'sealed' }, label: 'l1', reliable: false, serialization: 'binary' },
      dst: dst,
    });
    log('SEND ' + frame.slice(0, 100));
    member.send(frame);
    await sleep(4000);
    log('member alive=' + (member.readyState === 1) + ' master alive=' + (master.readyState === 1));
    master.close(); member.close();
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
      await b.cdp('Fetch.fulfillRequest', {
        requestId: m.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html' }],
        body: Buffer.from(PAGE).toString('base64'),
      }, tab.sessionId).catch(() => {});
    }
  });
  await b.cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://probe.test/*', requestStage: 'Request' }] }, tab.sessionId);
  await b.cdp('Page.navigate', { url: 'https://probe.test/main' }, tab.sessionId);
  for (let i = 0; i < 50; i++) {
    await sleep(500);
    const out = await b.eval(tab.sessionId, 'JSON.stringify(window.out)').catch(() => '[]');
    const lines = JSON.parse(out);
    if (lines.some((l) => l.includes('PROBE-DONE') || l.includes('PROBE-FAIL'))) { console.log(lines.join('\n')); break; }
  }
} finally { await b.close(); }
