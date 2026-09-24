// In-page UI: consent prompt + "<name> has the microphone · <duration>" pill.
// Rendered in a closed shadow root so Meet's CSS and ours never interact.

(() => {
  'use strict';

  const CSS = `
    :host { all: initial; }
    .root { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
            font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #e8eaed;
            display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
    .card, .pill { pointer-events: auto; background: #202124; border: 1px solid #3c4043; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
    .card { border-radius: 12px; padding: 14px 16px; max-width: 360px; }
    .card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
    .card p { margin: 0 0 12px; }
    .actions { display: flex; gap: 8px; justify-content: flex-end; }
    button { font: inherit; border-radius: 16px; border: 1px solid #5f6368; background: transparent; color: #8ab4f8;
             padding: 5px 14px; cursor: pointer; }
    button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #202124; font-weight: 600; }
    .pill { border-radius: 18px; padding: 6px 8px 6px 12px; display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; flex: none; }
    .dot.mine { background: #34a853; } .dot.other { background: #fbbc04; } .dot.warn { background: #ea4335; }
    .warn-text { color: #f28b82; }
    .pill button { padding: 2px 10px; }
    [hidden] { display: none !important; }
  `;

  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  /** Text for the ownership line; shared wording with the popup. */
  function ownerLine(snap, elapsedSinceSnapshot) {
    const o = snap.ownership;
    const held = o.ownerHeldMs === null ? null : o.ownerHeldMs + elapsedSinceSnapshot;
    if (o.ownerIsSelf && o.state === 'OWNER') return `You have the microphone · ${fmtDuration(held)}`;
    if (o.ownerId && !o.ownerIsSelf) {
      const line = `${o.ownerName} has the microphone${held === null ? '' : ` · ${fmtDuration(held)}`}`;
      return o.state === 'REQUESTED' ? `${line} — you're next` : line;
    }
    if (o.state === 'REQUESTED') return 'Requesting microphone…';
    return 'Microphone available';
  }

  function create({ onAction }) {
    document.getElementById('hotmic-overlay-host')?.remove(); // stale copy from a previous injection
    const host = document.createElement('div');
    host.id = 'hotmic-overlay-host';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="root">
        <div class="card prompt" hidden>
          <h3>Microphone Sharing</h3>
          <p class="prompt-text"></p>
          <div class="actions">
            <button class="decline">Not now</button>
            <button class="primary join">Join microphone sharing</button>
          </div>
        </div>
        <div class="pill status" hidden>
          <span class="dot"></span><span class="text"></span>
          <button class="toggle" hidden></button>
        </div>
      </div>`;
    const $ = (sel) => shadow.querySelector(sel);
    $('.join').addEventListener('click', () => onAction('join'));
    $('.decline').addEventListener('click', () => onAction('decline'));
    $('.toggle').addEventListener('click', () => onAction('toggle'));

    let snap = null;
    let snapAt = 0;
    let notice = null;

    const attach = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });

    function paint() {
      const prompt = $('.prompt');
      const pill = $('.status');
      const dot = $('.dot');
      const text = $('.text');
      const toggle = $('.toggle');
      if (!snap || snap.ended) {
        prompt.hidden = true;
        pill.hidden = !notice;
        toggle.hidden = true;
        if (notice) { text.textContent = notice; text.className = 'text warn-text'; dot.className = 'dot warn'; }
        return;
      }
      prompt.hidden = snap.participation !== 'PROMPTED' || !snap.prompt;
      if (!prompt.hidden) $('.prompt-text').textContent = snap.prompt;

      const joined = snap.participation === 'SHARING_JOINED';
      pill.hidden = !joined;
      if (!joined) return;
      const o = snap.ownership;
      if (snap.warning) {
        text.textContent = snap.warning;
        text.className = 'text warn-text';
        dot.className = 'dot warn';
      } else {
        text.textContent = ownerLine(snap, performance.now() - snapAt);
        text.className = 'text';
        dot.className = `dot ${o.ownerIsSelf && o.state === 'OWNER' ? 'mine' : o.ownerId ? 'other' : ''}`;
      }
      toggle.hidden = snap.mode !== 'toggle';
      toggle.textContent = snap.input.toggle === 'ON' ? 'Release' : 'Take mic';
    }

    const timer = setInterval(() => { if (snap && snap.ownership.ownerHeldMs !== null) paint(); }, 500);

    return {
      render(nextSnap, nextNotice = null) {
        snap = nextSnap;
        snapAt = performance.now();
        notice = nextNotice;
        attach();
        paint();
      },
      destroy() { clearInterval(timer); host.remove(); },
    };
  }

  globalThis.HotMicOverlay = Object.freeze({ create, fmtDuration, ownerLine });
})();
