/**
 * Track geometry tests: dimensions, arc-length parameterisation, collision
 * distance metric and checkpoint gate crossing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECKPOINT_COUNT,
  GATES,
  HALF_CIRCLE_LENGTH,
  LAP_LENGTH,
  ROAD_HALF_WIDTH,
  STRAIGHT_LENGTH,
  crossedGateForward,
  distanceToCenterline,
  normalizeS,
  poseAt,
  segmentsCross,
} from "../src/sim/track";

const TAU = Math.PI * 2;

test("circuit dimensions match the fixed contract", () => {
  assert.equal(STRAIGHT_LENGTH, 14);
  assert.equal(ROAD_HALF_WIDTH, 2);
  assert.ok(Math.abs(HALF_CIRCLE_LENGTH - Math.PI * 8) < 1e-12);
  assert.ok(Math.abs(LAP_LENGTH - (28 + 16 * Math.PI)) < 1e-12);
});

test("spawn is the beginning of the bottom straight, facing +X", () => {
  const spawn = poseAt(0);
  assert.ok(Math.abs(spawn.x - -7) < 1e-12);
  assert.ok(Math.abs(spawn.z - -8) < 1e-12);
  assert.ok(Math.abs(spawn.heading) < 1e-12);
});

test("centerline is continuous, correctly parameterised and closed", () => {
  const step = 0.01;
  let previous = poseAt(0);
  for (let s = step; s <= LAP_LENGTH + step; s += step) {
    const pose = poseAt(s);
    const gap = Math.hypot(pose.x - previous.x, pose.z - previous.z);
    assert.ok(Math.abs(gap - step) < 1e-3, `arc step at s=${s} was ${gap}`);
    previous = pose;
  }
  const end = poseAt(LAP_LENGTH);
  const start = poseAt(0);
  assert.ok(Math.hypot(end.x - start.x, end.z - start.z) < 1e-9);
  assert.ok(Math.abs(normalizeS(-1) - (LAP_LENGTH - 1)) < 1e-12);
});

test("half a lap lands exactly at the end of the right corner", () => {
  const pose = poseAt(LAP_LENGTH / 2);
  assert.ok(Math.abs(pose.x - 7) < 1e-9);
  assert.ok(Math.abs(pose.z - 8) < 1e-9);
  assert.ok(Math.abs(pose.heading - Math.PI) < 1e-9);
});

test("distance metric is zero on the centerline and measures the road band", () => {
  for (let i = 0; i < 200; i++) {
    const pose = poseAt((i / 200) * LAP_LENGTH);
    assert.ok(distanceToCenterline(pose.x, pose.z) < 1e-9);
  }
  // Straight section, both edges of the 4-wide road.
  assert.ok(Math.abs(distanceToCenterline(0, -8 + 1.9) - 1.9) < 1e-9);
  assert.ok(Math.abs(distanceToCenterline(0, -8 - 1.9) - 1.9) < 1e-9);
  // Right corner apex: outer road edge is at radius 10, inner at radius 6.
  assert.ok(Math.abs(distanceToCenterline(15, 0)) < 1e-9);
  assert.ok(Math.abs(distanceToCenterline(16.9, 0) - 1.9) < 1e-9);
  assert.ok(Math.abs(distanceToCenterline(13.1, 0) - 1.9) < 1e-9);
  // Infield and far outside are far from the centerline.
  assert.ok(Math.abs(distanceToCenterline(0, 0) - 8) < 1e-9);
  assert.ok(distanceToCenterline(0, -30) > 20);
});

test("there are eight evenly spaced checkpoints and the eighth is the finish", () => {
  assert.equal(GATES.length, CHECKPOINT_COUNT);
  assert.equal(GATES.length, 8);
  assert.ok(Math.abs(normalizeS(GATES[7].s)) < 1e-12, "gate 8 sits at the start/finish line");
  assert.ok(Math.abs(GATES[7].center.x - -7) < 1e-9);
  assert.ok(Math.abs(GATES[7].center.z - -8) < 1e-9);
  for (let i = 0; i < GATES.length; i++) {
    const gate = GATES[i];
    const expectedS = ((i + 1) * LAP_LENGTH) / 8;
    assert.ok(Math.abs(normalizeS(gate.s) - normalizeS(expectedS)) < 1e-9);
    const pose = poseAt(gate.s);
    assert.ok(Math.hypot(gate.center.x - pose.x, gate.center.z - pose.z) < 1e-9);
    // Gate endpoints lie exactly on the road edges.
    assert.ok(Math.abs(Math.hypot(gate.a.x - gate.center.x, gate.a.z - gate.center.z) - 2) < 1e-9);
    assert.ok(Math.abs(Math.hypot(gate.b.x - gate.center.x, gate.b.z - gate.center.z) - 2) < 1e-9);
    // The gate chord is perpendicular to the racing line.
    const abx = gate.b.x - gate.a.x;
    const abz = gate.b.z - gate.a.z;
    assert.ok(Math.abs(abx * gate.normal.x + abz * gate.normal.z) < 1e-9);
  }
  // Consecutive gates are LAP_LENGTH / 8 apart along the path.
  for (let i = 0; i < GATES.length; i++) {
    const next = GATES[(i + 1) % GATES.length];
    const delta = normalizeS(next.s - GATES[i].s);
    assert.ok(Math.abs(delta - LAP_LENGTH / 8) < 1e-9);
  }
});

test("segment intersection distinguishes proper crossings", () => {
  const a = { x: 0, z: 0 };
  const b = { x: 0, z: 2 };
  assert.equal(segmentsCross({ x: -1, z: 1 }, { x: 1, z: 1 }, a, b), true);
  assert.equal(segmentsCross({ x: 1, z: 1 }, { x: -1, z: 1 }, a, b), true);
  assert.equal(segmentsCross({ x: 1, z: 1 }, { x: 2, z: 1 }, a, b), false, "stops short");
  assert.equal(segmentsCross({ x: 0, z: -1 }, { x: 0, z: 1 }, a, b), false, "collinear overlap");
});

test("gate crossing requires forward motion through the gate", () => {
  const gate = GATES[0];
  const behind = { x: gate.center.x - gate.normal.x * 0.2, z: gate.center.z - gate.normal.z * 0.2 };
  const ahead = { x: gate.center.x + gate.normal.x * 0.2, z: gate.center.z + gate.normal.z * 0.2 };
  assert.equal(crossedGateForward(behind, ahead, gate), true);
  assert.equal(crossedGateForward(ahead, behind, gate), false, "backwards does not count");
  // Crossing the same plane far outside the road width does not cross the gate segment.
  const wideBehind = {
    x: behind.x - gate.normal.z * 3.5,
    z: behind.z + gate.normal.x * 3.5,
  };
  const wideAhead = { x: wideBehind.x + gate.normal.x * 0.4, z: wideBehind.z + gate.normal.z * 0.4 };
  assert.equal(crossedGateForward(wideBehind, wideAhead, gate), false);
  // Starting exactly on the gate line is not a crossing.
  assert.equal(crossedGateForward(gate.center, ahead, gate), false);
});

test("every gate is reachable within the road corridor", () => {
  for (const gate of GATES) {
    assert.ok(distanceToCenterline(gate.center.x, gate.center.z) < 1e-9);
    // A point 1.35 units off the centerline is still legal; 1.36 is not.
    const nx = -Math.sin(poseAt(gate.s).heading);
    const nz = Math.cos(poseAt(gate.s).heading);
    assert.ok(distanceToCenterline(gate.center.x + nx * 1.35, gate.center.z + nz * 1.35) <= 1.35 + 1e-9);
    assert.ok(distanceToCenterline(gate.center.x + nx * 1.36, gate.center.z + nz * 1.36) > 1.35);
  }
  // Just before the loop closes the heading is one full turn from the spawn.
  const nearEnd = poseAt(LAP_LENGTH - 1e-6);
  assert.ok(Math.abs(nearEnd.heading - TAU) < 1e-3, `end heading ${nearEnd.heading}`);
  assert.ok(Math.abs(poseAt(LAP_LENGTH).heading) < 1e-9);
});
