// HTTP client for the rendezvous server (rendezvous/server.mjs).

export class SignalClient {
  constructor(baseUrl, roomTag, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.base = `${baseUrl.replace(/\/+$/, '')}/v1/rooms/${roomTag}`;
    this.fetch = fetchImpl;
  }

  async _req(method, path, body, { signal, timeoutMs = 10000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ac.abort(new Error('stopped'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetch(this.base + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ac.signal,
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.status === 204 ? null : await res.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async masters() {
    const r = await this._req('GET', '/masters');
    return Array.isArray(r?.masters) ? r.masters.filter((x) => typeof x === 'string') : [];
  }

  async register(id) {
    const r = await this._req('POST', '/masters', { id });
    return Array.isArray(r?.masters) ? r.masters.filter((x) => typeof x === 'string') : [];
  }

  async unregister(id) { await this._req('DELETE', `/masters/${id}`); }

  async post(to, from, data) { await this._req('POST', `/inbox/${to}`, { from, data }); }

  async take(id, waitS, signal) {
    const r = await this._req('GET', `/inbox/${id}?wait=${waitS}`, null, { signal, timeoutMs: (waitS + 10) * 1000 });
    return Array.isArray(r?.messages) ? r.messages : [];
  }
}
