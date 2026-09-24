// Meet Adapter: detects the call UI and reads/controls Google Meet's own mute
// state through its DOM. Meet has no public API, so detection uses several
// independent signals and returns UNKNOWN rather than guessing.
//
//   * mic toggle: element with [data-is-muted] classified as the *microphone*
//     (keyboard hint "ctrl/⌘ + d" is not localised; words/icons as fallback)
//   * in call:    leave-call button (jsname / call_end icon / label) or
//                 participant tiles + mic toggle (the pre-join lobby has neither)

(() => {
  'use strict';

  const MIC_SHORTCUT = /[(（]\s*(?:ctrl|strg|control|⌘|cmd|command)\s*\+\s*d\s*[)）]/i;
  const CAM_SHORTCUT = /[(（]\s*(?:ctrl|strg|control|⌘|cmd|command)\s*\+\s*e\s*[)）]/i;
  const MIC_WORDS = /micro|\bmic\b|mikrofon|mikrofoni|μικρόφωνο|микрофон|マイク|麦克风|麥克風|마이크|माइक्रोफ़ोन/i;
  const CAM_WORDS = /camera|cámara|câmera|caméra|kamera|videocam|\bvideo\b|камера|カメラ|摄像头|攝影機|카메라/i;
  const LEAVE_WORDS = /leave call|end call|hang up|anruf verlassen|quitter l.appel|salir de la llamada|sair da chamada|abbandona|通話から退出|离开通话|退出通話|통화에서 나가기/i;

  function labelOf(el) {
    if (!el || !el.getAttribute) return '';
    const own = el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || el.getAttribute('title');
    if (own) return own;
    const inner = el.querySelector && el.querySelector('[aria-label],[data-tooltip]');
    return inner ? (inner.getAttribute('aria-label') || inner.getAttribute('data-tooltip') || '') : '';
  }

  function iconText(el) {
    const icons = el.querySelectorAll ? el.querySelectorAll('i, .google-material-icons, .material-icons-extended, span') : [];
    for (const i of icons) {
      const t = (i.textContent || '').trim();
      if (/^(mic|mic_off|mic_none|videocam|videocam_off|call_end)$/.test(t)) return t;
    }
    return '';
  }

  function isRendered(el) {
    return !!el && el.isConnected && el.getClientRects().length > 0;
  }

  function classify(el) {
    const label = labelOf(el);
    if (MIC_SHORTCUT.test(label)) return 'mic';
    if (CAM_SHORTCUT.test(label)) return 'camera';
    if (CAM_WORDS.test(label)) return 'camera';
    if (MIC_WORDS.test(label)) return 'mic';
    const icon = iconText(el);
    if (icon.startsWith('mic')) return 'mic';
    if (icon.startsWith('videocam')) return 'camera';
    return null;
  }

  /** Returns the Meet microphone toggle, or null if absent/ambiguous. */
  function findMicButton(doc = document) {
    const all = [...doc.querySelectorAll('[data-is-muted]')].filter(isRendered);
    const mics = all.filter((el) => classify(el) === 'mic');
    if (mics.length === 1) return mics[0];
    if (mics.length > 1) {
      // Duplicates (e.g. overflow toolbars) are fine only if they agree.
      const states = new Set(mics.map((m) => m.getAttribute('data-is-muted')));
      return states.size === 1 ? mics[0] : null;
    }
    return null;
  }

  function readMicState(btn) {
    if (!btn) return 'UNKNOWN';
    const v = btn.getAttribute('data-is-muted');
    if (v === 'true') return 'MUTED';
    if (v === 'false') return 'UNMUTED';
    return 'UNKNOWN';
  }

  function findLeaveButton(doc = document) {
    const byJsname = doc.querySelector('[jsname="CQylAd"]');
    if (isRendered(byJsname)) return byJsname;
    for (const b of doc.querySelectorAll('button, [role="button"]')) {
      if (!isRendered(b)) continue;
      if (LEAVE_WORDS.test(labelOf(b)) || iconText(b) === 'call_end') return b;
    }
    return null;
  }

  function isInCall(doc = document) {
    if (findLeaveButton(doc)) return true;
    return !!doc.querySelector('[data-participant-id]') && !!findMicButton(doc);
  }

  function clickMic(btn) {
    const target = btn.matches('button, [role="button"]') ? btn : (btn.querySelector('button, [role="button"]') || btn);
    target.click();
  }

  globalThis.HotMicMeetAdapter = Object.freeze({ findMicButton, readMicState, isInCall, clickMic, classify });
})();
