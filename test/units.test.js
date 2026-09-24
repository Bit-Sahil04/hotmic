import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMeetingId } from '../src/shared/meeting.js';
import { buildPromptText, ConsentManager } from '../src/background/consent.js';
import { compareRecords } from '../src/background/ownership.js';
import { validateMessage, newDeviceId, isDeviceId } from '../src/background/messages.js';
import { StateMachine, IllegalTransitionError } from '../src/shared/fsm.js';
import { InputManager } from '../src/background/input.js';
import { CONFIG } from '../src/shared/config.js';
import { FakeClock } from './sim.js';

test('parseMeetingId', () => {
  assert.equal(parseMeetingId('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(parseMeetingId('https://meet.google.com/ABC-DEFG-HIJ?authuser=1&hs=1'), 'abc-defg-hij');
  assert.equal(parseMeetingId('https://meet.google.com/abc-defg-hij/'), 'abc-defg-hij');
  assert.equal(parseMeetingId('https://meet.google.com/'), null);
  assert.equal(parseMeetingId('https://meet.google.com/landing'), null);
  assert.equal(parseMeetingId('https://meet.google.com/lookup/abcdef'), null);
  assert.equal(parseMeetingId('https://evil.com/abc-defg-hij'), null);
  assert.equal(parseMeetingId('http://meet.google.com/abc-defg-hij'), null);
  assert.equal(parseMeetingId('not a url'), null);
});

test('prompt text', () => {
  assert.equal(buildPromptText([{ name: 'Sahil', status: 'joined' }]),
    'Sahil is nearby and is using Microphone Sharing for this meeting.');
  assert.equal(buildPromptText([{ name: 'Sahil', status: 'joined' }, { name: 'Sheev', status: 'joined' }]),
    'Sahil and 1 other are nearby and are using Microphone Sharing for this meeting.');
  assert.match(buildPromptText([{ name: 'Samir', status: 'available' }]), /^Samir is nearby in this meeting/);
});

test('participation state machine', () => {
  const c = new ConsentManager();
  assert.equal(c.state, 'NOT_IN_MEETING');
  c.enterMeeting();
  assert.equal(c.updateNearby([]), false, 'no prompt without peers');
  assert.ok(c.updateNearby([{ name: 'S', status: 'joined' }]));
  assert.equal(c.state, 'PROMPTED');
  c.decline();
  assert.equal(c.state, 'SHARING_DECLINED');
  assert.equal(c.updateNearby([{ name: 'S', status: 'joined' }]), false, 'Not now is sticky for the session');
  assert.equal(c.broadcasting, false);
  c.join();
  assert.equal(c.state, 'SHARING_JOINED');
});

test('record ordering is a deterministic total order', () => {
  const A = 'a000000000000001', B = 'b000000000000002';
  assert.ok(compareRecords({ epoch: 2, owner: null }, { epoch: 1, owner: A }) > 0);
  assert.ok(compareRecords({ epoch: 1, owner: A }, { epoch: 1, owner: null }) > 0);
  assert.ok(compareRecords({ epoch: 1, owner: A }, { epoch: 1, owner: B }) > 0);
  assert.ok(compareRecords({ epoch: 1, owner: B }, { epoch: 1, owner: A }) < 0);
  assert.equal(compareRecords({ epoch: 1, owner: A }, { epoch: 1, owner: A }), 0);
});

test('device ids are random temporary identifiers', () => {
  const a = newDeviceId(), b = newDeviceId();
  assert.ok(isDeviceId(a) && isDeviceId(b));
  assert.notEqual(a, b);
});

test('validateMessage sanitises names and rejects extra junk', () => {
  const m = validateMessage({ k: 'hb', v: 1, d: 'a000000000000001', s: 0, ts: 1, n: ' Sa\u0000hil \n ', st: 'joined', m: 'MUTED', syn: true,
    r: { e: 0, o: null, h: 0 }, w: null, a: {}, pcm: 'AAAA' });
  assert.equal(m.n, 'Sahil');
  assert.equal('pcm' in m, false);
});

test('strict state machines reject illegal transitions', () => {
  const fsm = new StateMachine('t', 'A', { A: ['B'], B: [] }, { strict: true });
  assert.throws(() => fsm.transition('C'), IllegalTransitionError);
  assert.ok(fsm.transition('B'));
});

test('input manager: mode switch while holding releases the intent', () => {
  const clock = new FakeClock();
  const wants = [];
  const im = new InputManager({ clock, config: CONFIG, onWant: (w) => wants.push(w) });
  im.setEnabled(true);
  im.keyDown(false);
  clock.advance(100);
  assert.deepEqual(wants, [true]);
  im.setMode('toggle');
  assert.deepEqual(wants, [true, false]);
  assert.equal(im.wants, false);
});
