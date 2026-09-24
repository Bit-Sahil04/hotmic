// Meet Adapter DOM heuristics, exercised with minimal fake elements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/content/meet-adapter.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(src, ctx);
const A = ctx.HotMicMeetAdapter;

function el(attrs = {}, { text = '', rendered = true, children = [] } = {}) {
  return {
    isConnected: true, textContent: text, children,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    getClientRects: () => (rendered ? [1] : []),
    querySelector: () => null,
    querySelectorAll: () => children,
    matches: () => true,
    clicked: 0, click() { this.clicked++; },
  };
}
function doc(elements, extra = {}) {
  return { querySelectorAll: (sel) => (sel === '[data-is-muted]' ? elements : extra[sel] || []), querySelector: (sel) => extra[sel] || null };
}

test('classifies mic vs camera across locales', () => {
  assert.equal(A.classify(el({ 'aria-label': 'Turn off microphone (ctrl + d)' })), 'mic');
  assert.equal(A.classify(el({ 'aria-label': 'Turn on microphone (⌘ + d)' })), 'mic');
  assert.equal(A.classify(el({ 'aria-label': 'Désactiver le micro (ctrl + d)' })), 'mic');
  assert.equal(A.classify(el({ 'aria-label': 'Kamera ausschalten (Strg + E)' })), 'camera');
  assert.equal(A.classify(el({ 'aria-label': 'Turn off camera (ctrl + e)' })), 'camera');
  assert.equal(A.classify(el({ 'data-tooltip': 'マイクをオフにする' })), 'mic');
  assert.equal(A.classify(el({})), null);
});

test('finds the mic toggle and reads Meet state; ambiguous => null (UNKNOWN)', () => {
  const mic = el({ 'data-is-muted': 'false', 'aria-label': 'Turn off microphone (ctrl + d)' });
  const cam = el({ 'data-is-muted': 'true', 'aria-label': 'Turn on camera (ctrl + e)' });
  assert.equal(A.findMicButton(doc([cam, mic])), mic);
  assert.equal(A.readMicState(mic), 'UNMUTED');
  assert.equal(A.readMicState(cam), 'MUTED');
  assert.equal(A.readMicState(null), 'UNKNOWN');
  const hidden = el({ 'data-is-muted': 'true', 'aria-label': 'Turn on microphone (ctrl + d)' }, { rendered: false });
  assert.equal(A.findMicButton(doc([cam, mic, hidden])), mic, 'hidden duplicates ignored');
  const conflicting = el({ 'data-is-muted': 'true', 'aria-label': 'Turn on microphone (ctrl + d)' });
  assert.equal(A.findMicButton(doc([mic, conflicting])), null, 'two disagreeing mic toggles => unknown');
  assert.equal(A.findMicButton(doc([cam])), null);
});

test('in-call detection: leave button present vs lobby', () => {
  const mic = el({ 'data-is-muted': 'true', 'aria-label': 'Turn on microphone (ctrl + d)' });
  const leave = el({ 'aria-label': 'Leave call' });
  assert.equal(A.isInCall(doc([mic], { '[jsname="CQylAd"]': leave })), true);
  assert.equal(A.isInCall(doc([mic], { 'button, [role="button"]': [el({ 'aria-label': 'Leave call' })] })), true);
  assert.equal(A.isInCall(doc([mic], { 'button, [role="button"]': [el({ 'aria-label': 'Join now' })] })), false, 'pre-join lobby');
});
