// LAN transport via the native messaging helper (native-host/hotmic_host.js).
//
// Chrome extensions cannot open UDP sockets, so a tiny helper process relays
// opaque, already-encrypted envelopes over LAN multicast/broadcast. The helper
// has no protocol knowledge and never sees plaintext.
//
// States: idle | connecting | up | lost | unavailable

export class NativeTransport {
  constructor({ hostName, config, onMessage, onStatus, onNetworkChange }) {
    this.hostName = hostName;
    this.config = config;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onNetworkChange = onNetworkChange;
    this.state = 'idle';
    this.port = null;
    this.wanted = false;
    this.everUp = false;
    this.retryMs = config.TRANSPORT_RETRY_MIN_MS;
    this.retryTimer = null;
    this.readyTimer = null;
    this.lastError = null;
    this.helperInfo = null;
  }

  start() {
    this.wanted = true;
    if (!this.port && this.retryTimer === null) this._connect();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearTimeout(this.readyTimer); this.readyTimer = null;
    if (this.port) { try { this.port.disconnect(); } catch { /* ignore */ } }
    this.port = null;
    this.everUp = false;
    this._set('idle');
  }

  send(data) {
    if (this.state !== 'up' || !this.port) return false;
    try { this.port.postMessage({ type: 'send', data }); return true; } catch { return false; }
  }

  _connect() {
    this.retryTimer = null;
    if (!this.wanted) return;
    if (this.state !== 'lost' && this.state !== 'unavailable') this._set('connecting');
    let port;
    try {
      port = chrome.runtime.connectNative(this.hostName);
    } catch (err) {
      return this._failed(String(err && err.message || err));
    }
    this.port = port;
    port.onMessage.addListener((msg) => this._onHostMessage(port, msg));
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'helper exited';
      if (this.port !== port) return;
      this.port = null;
      this._failed(err);
    });
    clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => {
      if (this.port === port && this.state !== 'up') {
        try { port.disconnect(); } catch { /* ignore */ }
        this.port = null;
        this._failed('helper did not respond');
      }
    }, 5000);
  }

  _onHostMessage(port, msg) {
    if (this.port !== port || !msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
        clearTimeout(this.readyTimer);
        this.helperInfo = { version: msg.version, interfaces: msg.interfaces };
        this.lastError = null;
        this.retryMs = this.config.TRANSPORT_RETRY_MIN_MS;
        this.everUp = true;
        this._set('up');
        break;
      case 'recv':
        if (typeof msg.data === 'string') this.onMessage(msg.data);
        break;
      case 'network':
        this.helperInfo = { ...this.helperInfo, interfaces: msg.interfaces };
        this.onNetworkChange(msg);
        break;
      case 'error':
        this.lastError = String(msg.message || 'helper error');
        break;
      default:
        break;
    }
  }

  _failed(err) {
    clearTimeout(this.readyTimer);
    this.lastError = err;
    const notInstalled = /not found|forbidden|not allowed|access to the specified native messaging host/i.test(err);
    // Never-connected + not installed => local-only mode is allowed.
    // Was connected => coordination was lost; sessions must fail closed.
    this._set(this.everUp ? 'lost' : 'unavailable');
    if (!this.wanted) return;
    const delay = notInstalled ? this.config.TRANSPORT_RETRY_MAX_MS : this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.config.TRANSPORT_RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => this._connect(), delay);
  }

  _set(state) {
    if (state === this.state) return;
    this.state = state;
    this.onStatus(state);
  }
}
