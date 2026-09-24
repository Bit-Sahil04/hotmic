// WebRTC LAN transport (zero install). Service workers can't use
// RTCPeerConnection, so the mesh runs in an offscreen document
// (src/offscreen/). This class owns that document and presents the same
// interface as NativeTransport: state, start/stop, send(data), onMessage(data).
//
// States: idle | connecting | up | lost | unavailable

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

export class WebRtcTransport {
  constructor({ config, onMessage, onStatus, api = globalThis.chrome }) {
    this.config = config;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.api = api;
    this.state = 'idle';
    this.url = '';
    this.rooms = [];
    this.roomStatus = {};
    this.port = null;
    this.wanted = false;
    this.everUp = false;
    this.lastError = null;
    this.retryTimer = null;
  }

  get enabled() { return this.url !== 'off'; }

  info() {
    const rooms = this.rooms.map((id) => this.roomStatus[id]).filter(Boolean);
    return {
      configured: this.enabled,
      builtin: !this.url,
      off: this.url === 'off',
      url: this.url,
      state: this.state,
      error: this.lastError,
      role: rooms.find((r) => r.state === 'up')?.role || null,
      peers: rooms.reduce((n, r) => n + (r.peers || 0), 0),
    };
  }

  setUrl(url) {
    if (url === this.url) return;
    this.url = url;
    this.everUp = false;
    if (this.wanted) {
      if (this.enabled) this._ensureDocument(); else this._closeDocument();
    }
    this._pushConfig();
    this._recompute();
  }

  setRooms(meetingIds) {
    this.rooms = [...new Set(meetingIds)];
    for (const id of Object.keys(this.roomStatus)) if (!this.rooms.includes(id)) delete this.roomStatus[id];
    this._pushConfig();
    this._recompute();
  }

  start() {
    this.wanted = true;
    if (this.enabled) this._ensureDocument();
    this._recompute();
  }

  stop() {
    this.wanted = false;
    this.rooms = [];
    this.roomStatus = {};
    this.everUp = false;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this._pushConfig();
    this._closeDocument();
    this._recompute();
  }

  send(data) {
    if (this.state !== 'up' || !this.port) return false;
    try { this.port.postMessage({ type: 'send', data }); return true; } catch { return false; }
  }

  /** Called by the service worker for a 'hotmic-offscreen' runtime port. */
  attach(port) {
    if (this.port) { try { this.port.disconnect(); } catch { /* ignore */ } }
    this.port = port;
    port.onMessage.addListener((msg) => {
      if (this.port !== port || !msg || typeof msg !== 'object') return;
      if (msg.type === 'recv' && typeof msg.data === 'string') this.onMessage(msg.data);
      else if (msg.type === 'status' && msg.rooms && typeof msg.rooms === 'object') {
        this.roomStatus = {};
        for (const [id, st] of Object.entries(msg.rooms)) if (this.rooms.includes(id)) this.roomStatus[id] = sanitizeStatus(st);
        this._recompute();
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = null;
      this.roomStatus = {};
      this._recompute();
      // Offscreen document crashed or was closed: recreate it if still needed.
      if (this.wanted && this.enabled) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.wanted && this.enabled && !this.port) this._ensureDocument(); }, 1000);
      }
    });
    this._pushConfig();
    this._recompute();
  }

  _pushConfig() {
    if (!this.port) return;
    try { this.port.postMessage({ type: 'config', url: this.wanted ? this.url : '', rooms: this.wanted ? this.rooms : [] }); } catch { /* gone */ }
  }

  async _ensureDocument() {
    try {
      await this.api.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WEB_RTC'],
        justification: 'Discover nearby HotMic devices in the same meeting over LAN-only WebRTC data channels.',
      });
    } catch (err) {
      const msg = String(err && err.message || err);
      if (!/single offscreen|already/i.test(msg)) { this.lastError = `offscreen document: ${msg}`; this._recompute(); }
    }
  }

  _closeDocument() {
    try { Promise.resolve(this.api.offscreen.closeDocument()).catch(() => {}); } catch { /* none open */ }
  }

  _recompute() {
    let state;
    let error = null;
    if (!this.wanted) state = 'idle';
    else if (!this.enabled) { state = 'unavailable'; error = 'discovery turned off'; }
    else if (!this.port) state = this.everUp ? 'lost' : 'connecting';
    else {
      const st = this.rooms.map((id) => this.roomStatus[id]).filter(Boolean);
      if (st.some((s) => s.state === 'up')) state = 'up';
      else if (st.length < this.rooms.length || st.some((s) => s.state === 'connecting') || this.rooms.length === 0) state = 'connecting';
      else state = 'unavailable';
      error = st.find((s) => s.error)?.error || null;
    }
    if (state === 'up') this.everUp = true;
    this.lastError = error || (state === 'up' ? null : this.lastError);
    if (state !== this.state) {
      this.state = state;
      this.onStatus(state);
    } else {
      this.onStatus(state); // peers / role changed: refresh popups
    }
  }
}

function sanitizeStatus(st) {
  if (!st || typeof st !== 'object') return { state: 'connecting', role: 'member', peers: 0, error: null };
  return {
    state: ['connecting', 'up', 'unavailable', 'idle'].includes(st.state) ? st.state : 'connecting',
    role: st.role === 'master' ? 'master' : 'member',
    peers: Number.isInteger(st.peers) ? Math.max(0, Math.min(st.peers, 1000)) : 0,
    error: typeof st.error === 'string' ? st.error.slice(0, 200) : null,
  };
}
