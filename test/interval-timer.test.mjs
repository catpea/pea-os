import test from 'node:test';
import assert from 'node:assert/strict';
import { IntervalTimer, DEFAULT_CONFIG, buildPlan, validateConfig, formatTime }
  from '../src/fit/interval-timer.js';

const short = { warmup: 2, workout: 3, rest: 1, cooldown: 2, rounds: 2 };
function fixture(config = short) {
  let time = 1000;
  const timer = new IntervalTimer({ config, now: () => time });
  return { timer, advance: ms => { time += ms; }, setTime: ms => { time = ms; } };
}

test('configuration, zero phases, plan boundaries and display rounding', () => {
  assert.deepEqual(validateConfig({ workout: '15', rounds: '3' }),
    { ...DEFAULT_CONFIG, workout: 15, rounds: 3 });
  for (const config of [{workout:0},{rest:-1},{rounds:100},{warmup:3601},
    {workout:1.5},{rounds:true},{rest:null},{rest:''},{rest:'1e2'}]) {
    assert.throws(() => validateConfig(config));
  }
  const plan = buildPlan(short);
  assert.deepEqual(plan.map(step => step.phase), ['warmup','workout','rest','workout','cooldown']);
  assert.equal(plan.at(-1).endMs, 11000);
  assert.equal(plan.filter(step => step.phase === 'rest').length, 1);
  assert.deepEqual(buildPlan({warmup:0,workout:1,rest:0,cooldown:0,rounds:1})
    .map(step => step.phase), ['workout']);
  assert.equal(formatTime(1), '00:01');
  assert.equal(formatTime(60001), '01:01');
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(-1), '00:00');
  assert.throws(() => formatTime(NaN));
});

test('elapsed-time catchup crosses multiple phases and completes without drift', () => {
  const {timer,advance} = fixture();
  timer.start();
  advance(6500);
  const state = timer.tick();
  assert.equal(state.phase, 'workout');
  assert.equal(state.round, 2);
  assert.equal(state.stepIndex, 3);
  assert.equal(state.remainingMs, 2500);
  assert.equal(state.totalRemainingMs, 4500);
  assert.equal(state.elapsedMs, 6500);
  advance(100000);
  const done = timer.tick();
  assert.equal(done.status, 'completed');
  assert.equal(done.phaseLabel, 'Winner');
  assert.equal(done.remainingMs, 0);
  assert.equal(done.elapsedMs, done.totalMs);
  assert.equal(done.progress, 0);
  assert.equal(timer.start().status, 'running');
  assert.equal(timer.snapshot().elapsedMs, 0);
});

test('pause/resume excludes paused time and protects against backward clock steps', () => {
  const {timer,advance,setTime} = fixture();
  timer.start();
  advance(1250);
  assert.equal(timer.pause().remainingMs, 750);
  advance(30000);
  assert.equal(timer.tick().elapsedMs, 1250);
  timer.resume();
  advance(750);
  assert.equal(timer.tick().phase, 'workout');
  assert.equal(timer.snapshot().remainingMs, 3000);
  const stable = timer.snapshot();
  setTime(10);
  assert.deepEqual(timer.tick(), stable);
});

test('skip accounts for omitted remaining time and preserves paused state', () => {
  const {timer,advance} = fixture();
  assert.equal(timer.skip().status, 'idle');
  timer.start();
  advance(500);
  let state = timer.skip();
  assert.equal(state.phase, 'workout');
  assert.equal(state.elapsedMs, 2000);
  assert.equal(state.remainingMs, 3000);
  advance(1000);
  assert.equal(timer.tick().remainingMs, 2000);
  timer.pause();
  state = timer.skip();
  assert.equal(state.status, 'paused');
  assert.equal(state.phase, 'rest');
  assert.equal(state.totalRemainingMs, 6000);
  timer.skip();
  timer.skip();
  state = timer.skip();
  assert.equal(state.status, 'completed');
  assert.equal(state.totalRemainingMs, 0);
});

test('persistence restores running sessions paused and rejects malformed state atomically', () => {
  const {timer,advance} = fixture();
  timer.start(); advance(3250); timer.tick();
  const saved = JSON.parse(JSON.stringify(timer.exportState()));
  const other = new IntervalTimer({now:()=>9999999});
  let state = other.restoreState(saved);
  assert.equal(state.status, 'paused');
  assert.equal(state.phase, 'workout');
  assert.equal(state.remainingMs, 1750);
  assert.equal(state.elapsedMs, 3250);
  const before = other.snapshot();
  for (const bad of [null,{}, {...saved,schemaVersion:2}, {...saved,positionMs:-1},
    {...saved,positionMs:Infinity}, {...saved,status:'idle'},
    {...saved,status:'completed'}, {...saved,config:{workout:3}}]) {
    assert.throws(() => other.restoreState(bad));
    assert.deepEqual(other.snapshot(), before);
  }
  other.reset();
  state = other.restoreState({schemaVersion:1,config:short,status:'completed',positionMs:11000});
  assert.equal(state.status, 'completed');
});

test('subscriptions isolate observers, avoid unchanged ticks and sequence reentrant pauses', () => {
  const {timer,advance} = fixture();
  const events=[];
  timer.subscribe(()=>{throw new Error('view failure');},{emit:false});
  const stop=timer.subscribe(state=>events.push(state.status),{emit:false});
  timer.tick();
  assert.deepEqual(events,[]);
  const pause=timer.subscribe(state=>{if(state.status==='running')timer.pause();},{emit:false});
  timer.start();
  assert.deepEqual(events,['running','paused']);
  pause(); stop();
  advance(100);
  timer.resume();
  assert.deepEqual(events,['running','paused']);
  assert.throws(()=>timer.configure(short));
  timer.reset();
  assert.equal(timer.configure({workout:1,rounds:1,warmup:0,rest:0,cooldown:0}).stepCount,1);
});
