/**
 * Gameplay tests: crash behaviour, checkpoint ordering, lap scoring,
 * pause/resume and restart determinism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SPAWN, SIM_STEP, TinyApexSim, type SimSnapshot } from "../src/sim/game";
import { LAP_LENGTH } from "../src/sim/track";

const TAU = Math.PI * 2;

/** A simple "player" that steers through the corners and releases on straights. */
function autopilot(snapshot: SimSnapshot): boolean {
  const heading = ((snapshot.heading % TAU) + TAU) % TAU;
  const margin = 0.05;
  if (heading > margin && heading < Math.PI - margin) return true;
  if (heading > Math.PI + margin && heading < TAU - margin) return true;
  if (snapshot.x > 6.2 && snapshot.z < -6.5) return true;
  if (snapshot.x < -6.2 && snapshot.z > 6.5) return true;
  return false;
}

function stepMany(sim: TinyApexSim, seconds: number, input: (s: SimSnapshot) => boolean): void {
  const steps = Math.round(seconds / SIM_STEP);
  for (let i = 0; i < steps; i++) {
    sim.step(SIM_STEP, { steering: input(sim.getSnapshot()) });
    if (sim.getSnapshot().state === "crashed") return;
  }
}

test("initial state is ready, stationary at the spawn", () => {
  const sim = new TinyApexSim();
  const snapshot = sim.getSnapshot();
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.x, SPAWN.x);
  assert.equal(snapshot.z, SPAWN.z);
  assert.equal(snapshot.heading, SPAWN.heading);
  assert.equal(snapshot.points, 0);
  assert.equal(snapshot.laps, 0);
  assert.equal(snapshot.nextCheckpoint, 1);
  assert.equal(snapshot.elapsed, 0);
  // Stepping while ready does nothing until Start.
  sim.step(SIM_STEP, { steering: true });
  assert.equal(sim.getSnapshot().state, "ready");
  assert.equal(sim.getSnapshot().x, SPAWN.x);
});

test("driving straight without steering crashes off the first corner", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 5, () => false);
  const snapshot = sim.getSnapshot();
  assert.equal(snapshot.state, "crashed");
  assert.ok(snapshot.elapsed > 2.2 && snapshot.elapsed < 2.6, `crash at ${snapshot.elapsed}s`);
  assert.ok(snapshot.x > 11.6 && snapshot.x < 12.1, `crash x=${snapshot.x}`);
  assert.ok(Math.abs(snapshot.z - -8) < 1e-6);
  assert.equal(snapshot.steering, false);
  // It legitimately passed checkpoint 1 on the way, but never a lap.
  assert.equal(snapshot.points, 1);
  assert.equal(snapshot.laps, 0);
});

test("merely surviving does not score before a gate is reached", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 0.9, () => false);
  assert.equal(sim.getSnapshot().points, 0);
  assert.equal(sim.getSnapshot().laps, 0);
});

test("holding steering forever crashes quickly", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 3, () => true);
  const snapshot = sim.getSnapshot();
  assert.equal(snapshot.state, "crashed");
  assert.ok(snapshot.elapsed < 1, `crash at ${snapshot.elapsed}s`);
  assert.ok(snapshot.x > -3 && snapshot.x < -2, `crash x=${snapshot.x}`);
  assert.ok(snapshot.z > -7 && snapshot.z < -6.3, `crash z=${snapshot.z}`);
  assert.equal(snapshot.points, 0);
});

test("crash ends scoring: later steps do nothing", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 3, () => false);
  const crashed = sim.getSnapshot();
  sim.step(SIM_STEP, { steering: false });
  sim.step(SIM_STEP, { steering: true });
  const after = sim.getSnapshot();
  assert.equal(after.x, crashed.x);
  assert.equal(after.z, crashed.z);
  assert.equal(after.points, crashed.points);
});

test("a correctly timed straight/turn sequence completes laps", () => {
  const sim = new TinyApexSim();
  sim.start();
  const events: string[] = [];
  const laps = 3;
  const steps = Math.ceil((laps * LAP_LENGTH) / (8 * SIM_STEP)) + 2000;
  for (let i = 0; i < steps; i++) {
    const snapshot = sim.getSnapshot();
    if (snapshot.state === "crashed") break;
    sim.step(SIM_STEP, { steering: autopilot(snapshot) });
    for (const event of sim.drainEvents()) {
      if (event.type === "checkpoint") events.push(`cp${event.checkpoint}`);
      if (event.type === "lap") events.push(`lap${event.laps}`);
    }
    if (sim.getSnapshot().laps >= laps) break;
  }
  const snapshot = sim.getSnapshot();
  assert.equal(snapshot.state, "racing", "the autopilot should not crash");
  assert.equal(snapshot.laps, laps);
  assert.equal(snapshot.points, laps * 8, "one point per checkpoint, including the finish");
  const expected: string[] = [];
  for (let lap = 1; lap <= laps; lap++) {
    for (let cp = 1; cp <= 8; cp++) expected.push(`cp${cp}`);
    expected.push(`lap${lap}`);
  }
  assert.deepEqual(events, expected, "checkpoints must be scored in order");
  assert.ok(snapshot.nextCheckpoint >= 1 && snapshot.nextCheckpoint <= 8);
});

test("crossing the finish at the start of a run does not score", () => {
  const sim = new TinyApexSim();
  sim.start();
  // The car spawns exactly on the finish gate; moving forward must not award a lap.
  stepMany(sim, 0.5, () => false);
  const snapshot = sim.getSnapshot();
  assert.equal(snapshot.laps, 0);
  assert.equal(snapshot.points, 0);
  assert.equal(snapshot.nextCheckpoint, 1);
});

test("pause freezes the car and clears steering; resume continues the run", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 1, () => false);
  const before = sim.getSnapshot();
  sim.pause();
  assert.equal(sim.getSnapshot().state, "paused");
  sim.step(SIM_STEP, { steering: true });
  const paused = sim.getSnapshot();
  assert.equal(paused.x, before.x);
  assert.equal(paused.z, before.z);
  assert.equal(paused.elapsed, before.elapsed);
  assert.equal(paused.steering, false);
  sim.resume();
  sim.step(SIM_STEP, { steering: false });
  const resumed = sim.getSnapshot();
  assert.equal(resumed.state, "racing");
  assert.ok(resumed.x > paused.x, "the car keeps moving after resume");
});

test("invalid transitions are ignored", () => {
  const sim = new TinyApexSim();
  sim.restart();
  assert.equal(sim.getSnapshot().state, "ready", "cannot restart before a crash");
  sim.pause();
  assert.equal(sim.getSnapshot().state, "ready", "cannot pause before starting");
  sim.resume();
  assert.equal(sim.getSnapshot().state, "ready", "cannot resume while ready");
  sim.start();
  sim.start();
  assert.equal(sim.getSnapshot().state, "racing", "double start is harmless");
});

test("restart resets position, score, checkpoint progress, events and clock", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 3, () => false);
  assert.equal(sim.getSnapshot().state, "crashed");
  assert.ok(sim.getSnapshot().points > 0);
  sim.restart();
  const snapshot = sim.getSnapshot();
  assert.equal(snapshot.state, "racing");
  assert.equal(snapshot.x, SPAWN.x);
  assert.equal(snapshot.z, SPAWN.z);
  assert.equal(snapshot.heading, SPAWN.heading);
  assert.equal(snapshot.points, 0);
  assert.equal(snapshot.laps, 0);
  assert.equal(snapshot.nextCheckpoint, 1);
  assert.equal(snapshot.elapsed, 0);
  assert.equal(snapshot.steering, false);
  assert.equal(snapshot.crashX, 0);
  assert.equal(snapshot.crashZ, 0);
  assert.deepEqual(sim.drainEvents(), []);
});

test("the same input sequence produces identical runs (deterministic)", () => {
  const a = new TinyApexSim();
  const b = new TinyApexSim();
  a.start();
  b.start();
  for (let i = 0; i < 1200; i++) {
    const inputA = { steering: autopilot(a.getSnapshot()) };
    const inputB = { steering: autopilot(b.getSnapshot()) };
    assert.equal(inputA.steering, inputB.steering);
    a.step(SIM_STEP, inputA);
    b.step(SIM_STEP, inputB);
  }
  assert.deepEqual(a.getSnapshot(), b.getSnapshot());
});

test("draining events yields them exactly once", () => {
  const sim = new TinyApexSim();
  sim.start();
  stepMany(sim, 5, () => false);
  const first = sim.drainEvents();
  assert.ok(first.some((event) => event.type === "crash"));
  assert.deepEqual(sim.drainEvents(), []);
});
