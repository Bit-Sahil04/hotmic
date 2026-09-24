#!/usr/bin/env node
// HotMic rendezvous server: zero dependencies, in-memory, blind.
//
// It only helps nearby devices find each other the first time. It stores opaque
// room tags, random device ids and AES-GCM–sealed signalling blobs, all
// short-lived. It never sees meeting codes, names, IP-bearing SDP (sealed) or
// any audio, and carries no ongoing traffic: after the first WebRTC link,
// devices talk directly over the LAN.
//
//   GET    /v1/rooms/:tag/masters                 -> { masters: [id] }
//   POST   /v1/rooms/:tag/masters      {id}       -> { masters: [id] }   (register/refresh)
//   DELETE /v1/rooms/:tag/masters/:id
//   POST   /v1/rooms/:tag/inbox/:to    {from,data}
//   GET    /v1/rooms/:tag/inbox/:id?wait=20       -> { messages: [{from,data}] } (long-poll)
//
// Usage: PORT=8787 node rendezvous/server.mjs

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RendezvousStore, validId, validTag } from './store.mjs';

export function createServer({ store = new RendezvousStore(), rateLimit = { perSec: 20, burst: 60 } } = {}) {
  const buckets = new Map();
  const allow = (ip) => {
    const now = Date.now();
    const b = buckets.get(ip) || { tokens: rateLimit.burst, at: now };
    b.tokens = Math.min(rateLimit.burst, b.tokens + ((now - b.at) / 1000) * rateLimit.perSec);
    b.at = now;
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
  const sweeper = setInterval(() => {
    store.sweep();
    const cutoff = Date.now() - 60000;
    for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip);
  }, 15000);
  sweeper.unref();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, body) => {
      res.writeHead(status, body ? { 'Content-Type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.method === 'OPTIONS') return send(204);
    if (!allow(req.socket.remoteAddress || '?')) return send(429, { error: 'rate limited' });

    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === '/health') return send(200, { ok: true, service: 'hotmic-rendezvous' });
    const m = url.pathname.match(/^\/v1\/rooms\/([^/]+)\/(masters|inbox)(?:\/([^/]+))?$/);
    if (!m || !validTag(m[1]) || (m[3] !== undefined && !validId(m[3]))) return send(404, { error: 'not found' });
    const [, tag, kind, id] = m;

    try {
      if (kind === 'masters') {
        if (req.method === 'GET' && !id) return send(200, { masters: store.masters(tag) });
        if (req.method === 'POST' && !id) {
          const body = await readJson(req);
          if (!validId(body.id)) return send(400, { error: 'bad id' });
          return send(200, { masters: store.register(tag, body.id) });
        }
        if (req.method === 'DELETE' && id) { store.unregister(tag, id); return send(204); }
      } else if (kind === 'inbox' && id) {
        if (req.method === 'POST') {
          const body = await readJson(req);
          if (!validId(body.from) || typeof body.data !== 'string') return send(400, { error: 'bad message' });
          store.post(tag, id, body.from, body.data);
          return send(204);
        }
        if (req.method === 'GET') {
          const wait = Math.max(0, Math.min(25, Number(url.searchParams.get('wait')) || 0)) * 1000;
          const ac = new AbortController();
          res.on('close', () => ac.abort());
          const messages = await store.take(tag, id, wait, ac.signal);
          if (res.destroyed) return undefined;
          return send(200, { messages });
        }
      }
      return send(405, { error: 'method not allowed' });
    } catch (err) {
      if (err.status === 413) {
        // Oversized body: answer, then drop the connection instead of reading the rest.
        res.setHeader('Connection', 'close');
        res.on('finish', () => req.socket.destroy());
      }
      return send(err.status || 400, { error: err.message || 'error' });
    }
  });
  server.on('close', () => clearInterval(sweeper));
  return server;
}

function readJson(req, max = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { req.pause(); reject(Object.assign(new Error('too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '0.0.0.0';
  createServer().listen(port, host, () => console.log(`hotmic rendezvous listening on http://${host}:${port}`));
}
