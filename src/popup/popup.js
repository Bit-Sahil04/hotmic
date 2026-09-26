// Popup UI. Stateless view of the service worker's session snapshot for the
// active tab; all actions are sent back to the service worker.

const { ownerLine } = globalThis.HotMicOverlay; // shared wording (loaded before this module)
const $ = (id) => document.getElementById(id);

let state = null;
let stateAt = 0;
let capturingKey = false;
let nameDirty = false;
let urlDirty = false;

// ?tabId=N lets the popup be opened as a normal tab for a specific Meet tab (dev/testing).
const forcedTab = Number(new URLSearchParams(location.search).get('tabId'));
const [tab] = forcedTab ? [{ id: forcedTab }] : await chrome.tabs.query({ active: true, currentWindow: true });
const port = chrome.runtime.connect({ name: 'hotmic-popup' });
port.onMessage.addListener((msg) => {
  if (msg.type !== 'state') return;
  state = msg;
  stateAt = performance.now();
  render();
});
port.postMessage({ type: 'subscribe', tabId: tab?.id ?? -1 });

const action = (a) => port.postMessage({ type: 'action', action: a });
const settingsPatch = (patch) => port.postMessage({ type: 'settings', patch });

$('join').addEventListener('click', () => action('join'));
$('decline').addEventListener('click', () => action('decline'));
$('leave').addEventListener('click', () => action('leave'));
$('toggle-btn').addEventListener('click', () => action('toggle'));
for (const r of document.querySelectorAll('input[name=mode]')) {
  r.addEventListener('change', () => settingsPatch({ mode: r.value }));
}
$('display-name').addEventListener('input', () => { nameDirty = true; });
$('display-name').addEventListener('change', () => { nameDirty = false; settingsPatch({ displayName: $('display-name').value }); });
$('discovery-url').addEventListener('input', () => { urlDirty = true; $('discovery-url-error').hidden = true; });
$('discovery-url').addEventListener('change', () => {
  const v = $('discovery-url').value.trim();
  const ok = validUrl(v);
  $('discovery-url-error').hidden = ok;
  if (ok) { urlDirty = false; settingsPatch({ discoveryUrl: v }); }
});
$('discovery-info').addEventListener('click', () => {
  const help = $('discovery-help');
  help.hidden = !help.hidden;
});

function validUrl(v) {
  if (!v) return true;                 // built-in discovery cloud
  if (/^off$/i.test(v)) return true;   // WebRTC discovery disabled
  try {
    const u = new URL(v);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

$('ptt-key').addEventListener('click', () => {
  capturingKey = true;
  $('ptt-key').classList.add('capturing');
  $('ptt-key').textContent = 'Press a key…';
});
window.addEventListener('keydown', (e) => {
  if (!capturingKey) return;
  e.preventDefault();
  capturingKey = false;
  $('ptt-key').classList.remove('capturing');
  if (e.code !== 'Escape' && !['Tab', 'Enter'].includes(e.code)) settingsPatch({ pttKey: e.code });
  render();
});

setInterval(() => { if (state?.snapshot?.ownership?.ownerHeldMs != null) render(); }, 500);

function keyLabel(code) {
  if (!code) return '?';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = { Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', CapsLock: 'Caps Lock' };
  return map[code] || code;
}

function statusText(s, transport) {
  if (!s) {
    if (transport.state === 'unavailable') return 'No nearby discovery available';
    return transport.state === 'up' ? 'Connected' : transport.state === 'idle' ? 'Idle' : 'Connecting…';
  }
  switch (s.transport) {
    case 'up': return s.synced ? 'Connected' : 'Connected · syncing…';
    case 'unavailable': return s.localOnly ? 'Local only — no nearby discovery (see below)' : 'Disconnected';
    case 'lost': return 'Connection lost — microphone muted';
    default: return 'Connecting…';
  }
}

function helperLine(h) {
  switch (h.state) {
    case 'up': return 'LAN helper: connected';
    case 'connecting': return 'LAN helper: connecting…';
    case 'lost': return 'LAN helper: connection lost';
    case 'unavailable': return /not found|forbidden|not allowed/i.test(h.error || '') ? 'LAN helper: not installed' : `LAN helper: ${h.error || 'unavailable'}`;
    default: return 'LAN helper: idle';
  }
}

function webrtcLine(w) {
  if (w.off) return 'WebRTC: off';
  const label = w.builtin ? 'WebRTC (built-in cloud)' : 'WebRTC (your server)';
  switch (w.state) {
    case 'up': return `${label}: connected${w.role === 'master' ? ' · master' : ''} · ${w.peers} nearby link${w.peers === 1 ? '' : 's'}`;
    case 'connecting': return `${label}: connecting…`;
    case 'lost': return `${label}: connection lost`;
    case 'unavailable': return `${label}: ${w.error || 'unavailable'}`;
    default: return `${label}: idle`;
  }
}

function render() {
  if (!state) return;
  const s = state.snapshot;
  const settings = state.settings;
  const inMeet = !!s && !s.ended;

  $('no-meet').hidden = inMeet;
  $('meet').hidden = !inMeet;

  // settings (always visible)
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === settings.mode;
  $('key-heading').textContent = settings.mode === 'toggle' ? 'Toggle key' : 'PTT key';
  if (!capturingKey) $('ptt-key').textContent = `[ ${keyLabel(settings.pttKey)} ]`;
  if (!nameDirty && document.activeElement !== $('display-name')) $('display-name').value = settings.displayName;

  $('status').textContent = statusText(s, state.transport);
  const warn = s?.warning || null;
  const t = state.transport;
  $('paths').replaceChildren(...[helperLine(t.helper), webrtcLine(t.webrtc)].map((line) => {
    const d = document.createElement('div');
    d.textContent = line;
    return d;
  }));
  if (!urlDirty && document.activeElement !== $('discovery-url')) $('discovery-url').value = settings.discoveryUrl || '';
  $('warning').hidden = !warn;
  $('warning').textContent = warn || '';
  $('leave').hidden = !(inMeet && s.participation === 'SHARING_JOINED');

  if (!inMeet) { $('device').textContent = ''; return; }

  $('meeting-id').textContent = s.meetingId;
  const joined = s.participation === 'SHARING_JOINED';
  $('sharing-status').innerHTML = joined
    ? '<span class="on">●</span> Sharing enabled'
    : s.participation === 'SHARING_DECLINED' ? '○ Not sharing in this meeting' : '○ Sharing not enabled';

  // Consent: prompt (someone nearby) or an explicit join button (alone / declined earlier)
  const showPrompt = !joined;
  $('prompt').hidden = !showPrompt;
  $('prompt-text').textContent = s.prompt
    || (s.nearby.length ? `${s.nearby.map((n) => n.name).join(', ')} nearby in this meeting.`
      : s.participation === 'SHARING_DECLINED' ? 'You chose not to share the microphone in this meeting.'
        : 'No other participants nearby. You can still use microphone sharing.');
  $('decline').hidden = !['PROMPTED', 'IN_MEETING'].includes(s.participation);

  // Participants
  const others = s.participants.filter((p) => !p.self);
  $('participants-block').hidden = !joined || others.length === 0;
  $('alone').hidden = !joined || others.length > 0;
  const ul = $('participants');
  ul.replaceChildren(...s.participants.map((p) => {
    const li = document.createElement('li');
    if (p.hasMic) li.className = 'has-mic';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.self ? `${p.name} (you)` : p.name;
    const st = document.createElement('span');
    st.className = 'state';
    if (p.hasMic) st.textContent = 'MIC';
    else if (p.mic === 'UNMUTED') { st.textContent = 'unmuted!'; st.classList.add('bad'); }
    else if (p.mic === 'UNKNOWN') { st.textContent = 'unknown'; st.classList.add('bad'); }
    else st.textContent = 'muted';
    li.append(who, st);
    return li;
  }));

  const notJoinedNearby = joined ? s.nearby : [];
  $('nearby').hidden = notJoinedNearby.length === 0;
  $('nearby').textContent = notJoinedNearby.length ? `Also nearby (not sharing): ${notJoinedNearby.map((n) => n.name).join(', ')}` : '';

  // Ownership line
  $('owner-block').hidden = !joined;
  if (joined) $('owner-line').textContent = ownerLine(s, performance.now() - stateAt);
  $('toggle-btn').hidden = !joined || s.mode !== 'toggle';
  $('toggle-btn').textContent = s.input.toggle === 'ON' ? 'Release microphone' : 'Take microphone';

  // Microphone selected in Meet (observed, never chosen by us)
  const d = s.device;
  $('device').textContent = !d ? 'Meet microphone: not detected yet (reload Meet if this persists)'
    : d.available ? `Meet microphone: ${d.label}` : `Meet microphone unavailable: ${d.label}`;
}
