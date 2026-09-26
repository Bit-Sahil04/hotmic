// Probe public WebTorrent WS trackers: announce peer list, offer relay latency.
const TRACKERS = ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com:443', 'wss://tracker.openwebtorrent.com'];
const INFO = 'a1b2c3d4e5f6a7b8a9b0c1d2e3f4a5b6c7d8e9f0'; // 40 hex = 20 bytes
const pid = (n) => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, '0')).join(''); // 20 hex chars

function conn(url, id, log) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t0 = Date.now();
    ws.onopen = () => log(`${id} open`);
    ws.onmessage = (ev) => log(`${id} < +${Date.now() - t0}ms ${ev.data.slice(0, 220)}`);
    ws.onclose = (e) => log(`${id} close ${e.code}`);
    ws.onerror = () => reject(new Error(`${url} error`));
    ws.onopen = () => { log(`${id} open`); resolve({ ws, send: (o) => ws.send(JSON.stringify(o)) }); };
  });
}

for (const url of TRACKERS.slice(0, 1)) {
  console.log(`\n=== ${url} ===`);
  try {
    const A = await conn(url, 'A(master)', console.log);
    A.send({ action: 'announce', info_hash: INFO, peer_id: pid(), numwant: 10 });
    await new Promise((r) => setTimeout(r, 800));
    const B = await conn(url, 'B(member)', console.log);
    B.send({ action: 'announce', info_hash: INFO, peer_id: pid(), numwant: 10 });
    await new Promise((r) => setTimeout(r, 800));
    // B re-announces WITH an offer addressed to... we don't know A's peer_id from B's view?
    // (A's announce response shows whether the peer list includes ids.)
    console.log('--- re-announce A with an offer for B (need B peer_id from A\'s list) ---');
    A.send({ action: 'announce', info_hash: INFO, peer_id: pid(), numwant: 10, offers: [] });
    await new Promise((r) => setTimeout(r, 1500));
    A.ws.close(); B.ws.close();
  } catch (e) { console.log('FAIL', e.message); }
}
