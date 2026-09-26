// RCA repro: does PTT unmute without coordination, and does anyone else get muted?
import { World } from '../test/sim.js';
import { TRANSPORT } from '../src/background/session.js';

console.log('=== Scenario 1: discovery down on both devices (local-only), both joined ===');
{
  const w = new World({});
  const a = w.add('sahil', { transport: TRANSPORT.UNAVAILABLE, join: true });
  const b = w.add('samir', { transport: TRANSPORT.UNAVAILABLE, join: true });
  b.meet.manual('UNMUTED'); // B is talking normally in Meet
  w.pttDown('sahil');
  w.run(200);
  console.log(`after PTT down +200ms: A meet=${a.meet.state} (unmuted after ${a.meet.commands} cmds), B meet=${b.meet.state}`);
  console.log(`A ownership=${a.session.ownership.state} record=${JSON.stringify(w.rec('sahil'))}`);
  console.log('=> other person muted?', b.meet.state === 'MUTED');
}

console.log('\n=== Scenario 2: discovery UP, but B nearby and NOT joined ===');
{
  const w = new World({});
  const a = w.add('sahil', { transport: TRANSPORT.UP, join: true });
  const b = w.add('samir', { transport: TRANSPORT.UP, join: false }); // prompt showing, never clicked join
  w.run(2000); // let them see each other
  b.meet.manual('UNMUTED'); // B is talking normally
  w.pttDown('sahil');
  w.run(2500);
  console.log(`after PTT down +2.5s: A meet=${a.meet.state}, B meet=${b.meet.state}`);
  console.log(`A ownership=${a.session.ownership.state} nearby-not-joined visible to A:`, a.session.snapshot().nearby.map((n) => n.name));
  console.log('=> other person muted?', b.meet.state === 'MUTED');
}

console.log('\n=== Scenario 3 (control): discovery UP, both joined ===');
{
  const w = new World({});
  const a = w.add('sahil', { transport: TRANSPORT.UP, join: true });
  const b = w.add('samir', { transport: TRANSPORT.UP, join: true });
  b.meet.manual('UNMUTED'); // B was talking
  w.run(2000);
  w.pttDown('sahil');
  w.run(2500);
  console.log(`after PTT down +2.5s: A meet=${a.meet.state}, B meet=${b.meet.state}`);
  console.log('=> other person muted?', b.meet.state === 'MUTED');
}
