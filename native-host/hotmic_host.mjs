#!/usr/bin/env node
// HotMic LAN helper (Chrome native messaging host).
//
// A dumb relay: forwards opaque, already-encrypted envelopes from the extension
// to the local network and back. It knows nothing about meetings, names or
// ownership, never sees plaintext, and never touches audio.
//
//   extension -> helper : {type:'send', data:string}
//   helper -> extension : {type:'ready'|'recv'|'network'|'error', ...}
//
// Delivery: UDP multicast (239.255.77.77:47777, TTL 1 = never leaves the LAN)
// + subnet broadcast on every IPv4 interface + unicast to recently heard peers
// (Wi-Fi multicast is lossy; unicast frames get link-layer retries).

import dgram from 'node:dgram';
import os from 'node:os';
import { createHash } from 'node:crypto';

const VERSION = '1.0.0';
const GROUP = process.env.HOTMIC_GROUP || '239.255.77.77';
const PORT = Number(process.env.HOTMIC_PORT || 47777);
const MAGIC = Buffer.from('HOTMIC1\n', 'latin1');
const PREFIX = '{"p":"hotmic"';
const MAX_DATAGRAM = 8192;
const MAX_NATIVE_MSG = 1024 * 1024;
const PEER_TTL_MS = 15000;
const RESCAN_MS = 3000;
const DEDUPE_MS = 5000;
const noop = () => {};
const log = (...a) => { try { process.stderr.write(`[hotmic-host] ${a.join(' ')}\n`); } catch { /* ignore */ } };

// ---- native messaging framing (stdout is reserved for Chrome) --------------------

let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (len > MAX_NATIVE_MSG) { log('oversized message'); shutdown(1); return; }
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len);
    inBuf = inBuf.subarray(4 + len);
    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch { continue; }
    onExtensionMessage(msg);
  }
});
process.stdin.on('end', () => shutdown(0));
process.stdin.on('error', () => shutdown(0));

function toExtension(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(body.length, 0);
  try { process.stdout.write(Buffer.concat([hdr, body])); } catch { shutdown(0); }
}

function onExtensionMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'send' && typeof msg.data === 'string' && msg.data.startsWith(PREFIX)) relay(msg.data);
}

// ---- interfaces ------------------------------------------------------------------------

function ipv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        out.push({ name, address: a.address, broadcast: broadcastAddr(a.address, a.netmask) });
      }
    }
  }
  return out;
}

function broadcastAddr(addr, mask) {
  const a = addr.split('.').map(Number);
  const m = (mask || '255.255.255.0').split('.').map(Number);
  return a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.');
}

// ---- sockets -----------------------------------------------------------------------------

const senders = new Map();   // address -> {iface, sock, ready}
const joined = new Set();    // addresses with multicast membership
const localAddrs = new Set();
const peers = new Map();     // ip -> last heard
const recent = new Map();    // datagram hash -> time (dedupe + own-echo suppression)
let ifaceKey = '';

const rx = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const uni = dgram.createSocket({ type: 'udp4', reuseAddr: true });
uni.on('error', noop);

rx.on('error', (err) => {
  toExtension({ type: 'error', message: `socket error: ${err.message}` });
  shutdown(1);
});

rx.on('message', (buf, rinfo) => {
  if (buf.length > MAX_DATAGRAM || buf.length <= MAGIC.length) return;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) return;
  const data = buf.toString('utf8', MAGIC.length);
  if (!data.startsWith(PREFIX)) return;
  if (!localAddrs.has(rinfo.address)) peers.set(rinfo.address, Date.now());
  if (seen(data)) return;
  toExtension({ type: 'recv', data });
});

function seen(data) {
  const h = createHash('sha1').update(data).digest('base64');
  const now = Date.now();
  if (recent.has(h)) return true;
  recent.set(h, now);
  if (recent.size > 2000) for (const [k, t] of recent) { if (now - t > DEDUPE_MS) recent.delete(k); else break; }
  return false;
}

function relay(data) {
  const buf = Buffer.concat([MAGIC, Buffer.from(data, 'utf8')]);
  if (buf.length > MAX_DATAGRAM) return;
  seen(data); // our own multicast loopback is dropped; other local processes still get it
  for (const s of senders.values()) {
    if (!s.ready) continue;
    s.sock.send(buf, PORT, GROUP, noop);
    if (s.iface.broadcast !== s.iface.address) s.sock.send(buf, PORT, s.iface.broadcast, noop);
  }
  const now = Date.now();
  for (const [ip, t] of peers) {
    if (now - t > PEER_TTL_MS) { peers.delete(ip); continue; }
    uni.send(buf, PORT, ip, noop);
  }
}

function makeSender(iface) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const s = { iface, sock, ready: false };
  sock.on('error', noop);
  sock.bind(0, iface.address, () => {
    try {
      sock.setBroadcast(true);
      sock.setMulticastTTL(1);
      sock.setMulticastLoopback(true);
      sock.setMulticastInterface(iface.address);
      s.ready = true;
    } catch (err) { log('sender setup failed', iface.address, err.message); }
  });
  return s;
}

function rescan(initial = false) {
  const ifaces = ipv4Interfaces();
  const key = ifaces.map((i) => `${i.name}=${i.address}`).sort().join(',');
  if (key === ifaceKey && !initial) return;
  ifaceKey = key;
  const current = new Set(ifaces.map((i) => i.address));
  for (const [addr, s] of senders) {
    if (!current.has(addr)) { try { s.sock.close(); } catch { /* ignore */ } senders.delete(addr); }
  }
  for (const addr of [...joined]) {
    if (!current.has(addr)) { try { rx.dropMembership(GROUP, addr); } catch { /* iface gone */ } joined.delete(addr); }
  }
  localAddrs.clear();
  for (const i of ifaces) {
    localAddrs.add(i.address);
    if (!senders.has(i.address)) senders.set(i.address, makeSender(i));
    if (!joined.has(i.address)) {
      try { rx.addMembership(GROUP, i.address); joined.add(i.address); } catch (err) { log('join failed', i.address, err.message); }
    }
  }
  peers.clear(); // peers are re-learned on the new network
  if (!initial) toExtension({ type: 'network', interfaces: ifaces.length });
}

let rescanTimer = null;
rx.bind(PORT, () => {
  try { rx.setMulticastLoopback(true); } catch { /* ignore */ }
  rescan(true);
  rescanTimer = setInterval(() => rescan(false), RESCAN_MS);
  toExtension({ type: 'ready', version: VERSION, interfaces: senders.size });
});

let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;
  clearInterval(rescanTimer);
  for (const s of senders.values()) { try { s.sock.close(); } catch { /* ignore */ } }
  try { rx.close(); } catch { /* ignore */ }
  try { uni.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 50);
}
