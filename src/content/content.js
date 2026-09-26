// Meet content script (isolated world). Thin layer:
//   * reports {url, in-call, Meet mic state + cause} to the service worker
//   * executes mute/unmute commands and verifies the resulting Meet state
//   * captures the PTT/toggle key (and suppresses Meet's own handling of it)
//   * reports focus loss, device info and activity samples
//   * renders the in-page overlay
// If the service worker disappears, it fails closed by muting Meet locally.

(() => {
  'use strict';
  const A = globalThis.HotMicMeetAdapter;
  const UI = globalThis.HotMicOverlay;
  if (!A || !UI) return;

  // A re-injected copy (extension reload) replaces the old one.
  if (globalThis.__hotmicContent) { try { globalThis.__hotmicContent.teardown(); } catch { /* ignore */ } }

  const CH = 'hotmic:probe';
  const pageId = crypto.randomUUID();
  let cfg = { MEET_POLL_MS: 300, MEET_VERIFY_TIMEOUT_MS: 1000, MEET_UNKNOWN_GRACE_MS: 1000, MEET_EXIT_GRACE_MS: 1500, ACTIVITY_POLL_MS: 300 };
  let settings = { pttKey: 'Space', mode: 'ptt' };
  let port = null;
  let dead = false;
  let snapshot = null;
  let reported = null;
  let lastMic = 'UNKNOWN';
  let micMissingSince = null;
  let inCall = false;
  let lastInCallAt = -Infinity;
  let pendingCmd = null;
  let pollTimer = null;
  let pingTimer = null;
  let activityPolling = false;
  let checkQueued = false;

  const overlay = UI.create({ onAction: (action) => send({ type: 'action', action }) });

  // ---- messaging ------------------------------------------------------------------

  function send(msg) {
    if (!port) return;
    try { port.postMessage(msg); } catch { /* disconnected */ }
  }

  function connect() {
    if (dead) return;
    try {
      port = chrome.runtime.connect({ name: 'hotmic-meet' });
    } catch {
      teardown(); // extension context invalidated
      return;
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnected);
    send({ type: 'hello', pageId });
    reported = null;
    check();
    postProbe({ type: 'device-query' });
  }

  function onDisconnected() {
    port = null;
    const wasJoined = snapshot && snapshot.participation === 'SHARING_JOINED';
    if (wasJoined) muteNow(); // fail closed: coordination is gone
    snapshot = null;
    setActivityPolling(false);
    overlay.render(null, wasJoined ? 'Microphone Sharing disconnected — microphone muted' : null);
    let alive = false;
    try { alive = !!chrome.runtime?.id; } catch { alive = false; }
    if (!alive) { teardown(true); return; }
    setTimeout(connect, 1000);
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'config') {
      cfg = { ...cfg, ...msg.config };
      settings = { ...settings, ...msg.settings };
      restartPolling();
    } else if (msg.type === 'state') {
      snapshot = msg.snapshot;
      overlay.render(snapshot);
      setActivityPolling(!!snapshot && !!snapshot.wantsActivity);
    } else if (msg.type === 'set-mute') {
      handleSetMute(msg);
    }
  }

  // ---- Meet state -------------------------------------------------------------------

  function computeState() {
    const now = performance.now();
    const raw = A.readMicState(A.findMicButton());
    let mic;
    if (raw === 'UNKNOWN') {
      if (micMissingSince === null) micMissingSince = now;
      mic = now - micMissingSince >= cfg.MEET_UNKNOWN_GRACE_MS ? 'UNKNOWN' : lastMic; // ride out re-renders
    } else {
      micMissingSince = null;
      mic = raw;
    }
    lastMic = mic;
    if (A.isInCall()) { inCall = true; lastInCallAt = now; } else if (inCall && now - lastInCallAt >= cfg.MEET_EXIT_GRACE_MS) inCall = false;
    return { href: location.href, inCall, mic };
  }

  function check() {
    checkQueued = false;
    if (dead) return;
    const s = computeState();
    if (reported && s.href === reported.href && s.inCall === reported.inCall && s.mic === reported.mic) return;
    let cause = 'external';
    if (!reported || reported.mic === undefined) cause = 'initial';
    else if (pendingCmd && s.mic === pendingCmd.target) cause = 'command';
    else if (s.mic === reported.mic) cause = 'initial'; // only url / in-call changed
    reported = s;
    send({ type: 'meet', href: s.href, inCall: s.inCall, mic: s.mic, cause });
  }

  function queueCheck() {
    if (checkQueued) return;
    checkQueued = true;
    queueMicrotask(check);
  }

  const observer = new MutationObserver(queueCheck);
  function startObserver() {
    observer.disconnect();
    observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-is-muted'] });
  }

  function restartPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(check, cfg.MEET_POLL_MS);
  }

  // ---- commands ----------------------------------------------------------------------

  async function handleSetMute({ id, muted }) {
    const target = muted ? 'MUTED' : 'UNMUTED';
    const btn = A.findMicButton();
    const cur = A.readMicState(btn);
    if (!btn || cur === 'UNKNOWN') { send({ type: 'mic-result', id, ok: false, mic: 'UNKNOWN' }); return; }
    if (cur === target) { check(); send({ type: 'mic-result', id, ok: true, mic: cur }); return; }
    pendingCmd = { id, target };
    try { A.clickMic(btn); } catch { /* reported as failure below */ }
    const ok = await waitFor(() => A.readMicState(A.findMicButton()) === target, cfg.MEET_VERIFY_TIMEOUT_MS);
    check();
    if (pendingCmd && pendingCmd.id === id) pendingCmd = null;
    send({ type: 'mic-result', id, ok, mic: A.readMicState(A.findMicButton()) });
  }

  function waitFor(pred, ms) {
    return new Promise((resolve) => {
      if (pred()) { resolve(true); return; }
      let finished = false;
      const done = (v) => { if (finished) return; finished = true; mo.disconnect(); clearInterval(iv); clearTimeout(to); resolve(v); };
      const mo = new MutationObserver(() => { if (pred()) done(true); });
      mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-is-muted'] });
      const iv = setInterval(() => { if (pred()) done(true); }, 50);
      const to = setTimeout(() => done(pred()), ms);
    });
  }

  /** Local fail-safe mute used when the service worker is unreachable. */
  function muteNow() {
    try {
      const btn = A.findMicButton();
      if (A.readMicState(btn) === 'UNMUTED') A.clickMic(btn);
    } catch { /* ignore */ }
  }

  // ---- input ---------------------------------------------------------------------------

  const joined = () => !!snapshot && snapshot.participation === 'SHARING_JOINED';

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !/^(button|checkbox|radio|range|submit|reset|color|file|image)$/i.test(el.type || '');
    return false;
  }

  function onKeyDown(e) {
    if (!joined() || e.code !== settings.pttKey) return;
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    if (isEditable(target) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Stop Meet's own handlers (e.g. hold-space-to-unmute) from acting on our key.
    e.preventDefault();
    e.stopImmediatePropagation();
    send({ type: 'key', action: 'down', repeat: !!e.repeat });
  }

  function onKeyUp(e) {
    if (!joined() || e.code !== settings.pttKey) return;
    const target = e.composedPath ? e.composedPath()[0] : e.target;
    if (!isEditable(target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    send({ type: 'key', action: 'up' }); // always forward releases
  }

  const onBlur = () => send({ type: 'focus-lost', reason: 'window lost focus' });
  const onVisibility = () => { if (document.hidden) send({ type: 'focus-lost', reason: 'tab hidden' }); };
  const onPageHide = () => send({ type: 'focus-lost', reason: 'page hidden' });
  const onFreeze = () => send({ type: 'focus-lost', reason: 'page frozen' });

  // ---- page probe (MAIN world) ------------------------------------------------------

  function postProbe(data) {
    try { window.postMessage({ [CH]: 1, from: 'content', ...data }, location.origin); } catch { /* ignore */ }
  }

  function setActivityPolling(on) {
    if (on === activityPolling) return;
    activityPolling = on;
    postProbe({ type: 'activity-poll', ms: on ? cfg.ACTIVITY_POLL_MS : 0 });
  }

  function onWindowMessage(e) {
    if (e.source !== window || !e.data || e.data[CH] !== 1 || e.data.from !== 'probe') return;
    if (e.data.type === 'device') send({ type: 'device', device: e.data.device || null });
    else if (e.data.type === 'activity' && typeof e.data.level === 'number') send({ type: 'activity', level: e.data.level });
  }

  // ---- lifecycle --------------------------------------------------------------------------

  function teardown(fromDisconnect = false) {
    if (dead) return;
    dead = true;
    if (!fromDisconnect && snapshot && snapshot.participation === 'SHARING_JOINED') muteNow();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('message', onWindowMessage);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('freeze', onFreeze);
    observer.disconnect();
    clearInterval(pollTimer);
    clearInterval(pingTimer);
    setActivityPolling(false);
    try { port?.disconnect(); } catch { /* ignore */ }
    port = null;
    // Keep a visible notice briefly if we just failed closed, then remove the overlay.
    setTimeout(() => overlay.destroy(), fromDisconnect ? 8000 : 0);
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('message', onWindowMessage);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('freeze', onFreeze);
  startObserver();
  restartPolling();
  pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
  globalThis.__hotmicContent = { teardown, action: (a) => send({ type: 'action', action: String(a || '') }), snap: () => snapshot };
  connect();
})();
