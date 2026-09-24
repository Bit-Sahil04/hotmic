// Device Manager (page side). Runs in the page's MAIN world at document_start.
//
// OBSERVES ONLY — it never selects, opens or changes a microphone:
//   * which capture device Google Meet obtained via getUserMedia (source of truth)
//   * whether that device went away (track 'ended' / devicechange)
//   * a browser-computed outgoing audio level from WebRTC stats (activity signal)
// No audio samples are read, processed, stored or transmitted.

(() => {
  'use strict';
  const FLAG = '__hotmicProbeInstalled';
  if (window[FLAG]) return;
  try { Object.defineProperty(window, FLAG, { value: true }); } catch { return; }

  const CH = 'hotmic:probe';
  const post = (data) => {
    try { window.postMessage({ [CH]: 1, from: 'probe', ...data }, location.origin); } catch { /* ignore */ }
  };

  // ---- Meet-selected microphone ------------------------------------------------
  let current = null; // { track, deviceId, available }

  function report(reason) {
    if (!current) { post({ type: 'device', reason, device: null }); return; }
    const t = current.track;
    post({
      type: 'device', reason,
      device: {
        label: t.label || 'Microphone',
        available: current.available && t.readyState === 'live',
        readyState: t.readyState,
        trackMuted: t.muted, // source not delivering audio (e.g. OS-level mute / device issue)
      },
    });
  }

  function observeStream(stream) {
    const tracks = stream && typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks() : [];
    if (!tracks.length) return;
    const track = tracks[0];
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    current = { track, deviceId: settings.deviceId || null, available: true };
    const mine = () => current && current.track === track;
    // 'ended' only fires when the *source* ends (unplugged, revoked), not on stop().
    track.addEventListener('ended', () => { if (mine()) { current.available = false; report('device-ended'); } });
    track.addEventListener('mute', () => { if (mine()) report('track-muted'); });
    track.addEventListener('unmute', () => { if (mine()) report('track-unmuted'); });
    report('acquired');
  }

  if (window.MediaDevices && MediaDevices.prototype.getUserMedia) {
    const origGUM = MediaDevices.prototype.getUserMedia;
    MediaDevices.prototype.getUserMedia = function getUserMedia(constraints) {
      const p = origGUM.call(this, constraints);
      try { if (constraints && constraints.audio) p.then(observeStream, () => {}); } catch { /* ignore */ }
      return p; // Meet receives the untouched original promise
    };
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      if (!current || !current.deviceId) return;
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const present = list.some((d) => d.kind === 'audioinput' && d.deviceId === current.deviceId);
        if (present !== current.available) { current.available = present; report('devicechange'); }
      } catch { /* ignore */ }
    });
  }

  // ---- Activity: browser-computed audioLevel of Meet's outgoing audio -----------
  const pcs = new Set();
  const OrigPC = window.RTCPeerConnection;
  if (typeof OrigPC === 'function') {
    const Wrapped = function RTCPeerConnection(...args) {
      const pc = new OrigPC(...args); // returns a genuine RTCPeerConnection
      pcs.add(pc);
      return pc;
    };
    Wrapped.prototype = OrigPC.prototype;
    Object.setPrototypeOf(Wrapped, OrigPC); // keep statics (generateCertificate)
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
  }

  let pollTimer = null;
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    let level = null;
    try {
      for (const pc of pcs) {
        if (pc.signalingState === 'closed') { pcs.delete(pc); continue; }
        try {
          const stats = await pc.getStats();
          stats.forEach((r) => {
            if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
              level = Math.max(level ?? 0, r.audioLevel);
            }
          });
        } catch { /* ignore */ }
      }
    } finally { polling = false; }
    if (level !== null) post({ type: 'activity', level });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[CH] !== 1 || e.data.from !== 'content') return;
    if (e.data.type === 'activity-poll') {
      clearInterval(pollTimer);
      pollTimer = null;
      const ms = Number(e.data.ms);
      if (ms > 0) pollTimer = setInterval(poll, Math.max(100, ms));
    } else if (e.data.type === 'device-query') {
      report('query');
    }
  });
})();
