/**
 * Tiny Apex — simulation state machine.
 *
 * Owns the car, checkpoints, scoring and run state. The renderer never
 * mutates this; it reads snapshots and replays events. Pure and
 * deterministic: no DOM, no Three.js, no randomness.
 */

import {
  CAR_RADIUS,
  CAR_SPEED,
  CHECKPOINT_COUNT,
  GATES,
  ROAD_HALF_WIDTH,
  TURN_RATE,
  crossedGateForward,
  distanceToCenterline,
  poseAt,
  type Pose,
  type Vec2,
} from "./track";

export type GameState = "ready" | "racing" | "paused" | "crashed";

export interface SimInput {
  steering: boolean;
}

export type SimEvent =
  | { type: "checkpoint"; checkpoint: number; points: number }
  | { type: "lap"; laps: number; points: number }
  | { type: "crash"; x: number; z: number };

export interface SimSnapshot {
  state: GameState;
  x: number;
  z: number;
  heading: number;
  prevX: number;
  prevZ: number;
  prevHeading: number;
  steering: boolean;
  points: number;
  laps: number;
  /** 1-based checkpoint the player must reach next. */
  nextCheckpoint: number;
  elapsed: number;
  crashX: number;
  crashZ: number;
}

/** Fixed simulation step: 120 Hz, independent of display refresh rate. */
export const SIM_STEP = 1 / 120;

/** Every run starts here: the beginning of the bottom straight, facing +X. */
export const SPAWN: Pose = poseAt(0);

const MAX_CENTERLINE_DISTANCE = ROAD_HALF_WIDTH - CAR_RADIUS;

export class TinyApexSim {
  private state: GameState = "ready";
  private x = SPAWN.x;
  private z = SPAWN.z;
  private heading = SPAWN.heading;
  private prevX = SPAWN.x;
  private prevZ = SPAWN.z;
  private prevHeading = SPAWN.heading;
  private steering = false;
  private points = 0;
  private laps = 0;
  private nextIndex = 0;
  private elapsed = 0;
  private crashX = 0;
  private crashZ = 0;
  private events: SimEvent[] = [];

  /** Ready → racing. */
  start(): void {
    if (this.state === "ready") this.resetRun();
  }

  /** Crashed → racing with a completely fresh run. */
  restart(): void {
    if (this.state === "crashed") this.resetRun();
  }

  /** Racing → paused. Clears any held steering. */
  pause(): void {
    if (this.state === "racing") {
      this.state = "paused";
      this.steering = false;
    }
  }

  /** Paused → racing. The caller resets its frame clock; no time is fast-forwarded. */
  resume(): void {
    if (this.state === "paused") {
      this.state = "racing";
      this.steering = false;
    }
  }

  private resetRun(): void {
    this.x = SPAWN.x;
    this.z = SPAWN.z;
    this.heading = SPAWN.heading;
    this.prevX = SPAWN.x;
    this.prevZ = SPAWN.z;
    this.prevHeading = SPAWN.heading;
    this.steering = false;
    this.points = 0;
    this.laps = 0;
    this.nextIndex = 0;
    this.elapsed = 0;
    this.crashX = 0;
    this.crashZ = 0;
    this.events = [];
    this.state = "racing";
  }

  /** Advance the simulation by one fixed step. No-op unless racing. */
  step(dt: number, input: SimInput): void {
    if (this.state !== "racing") return;

    this.steering = input.steering;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevHeading = this.heading;

    let heading = this.heading;
    if (input.steering) heading += TURN_RATE * dt;

    this.x += Math.cos(heading) * CAR_SPEED * dt;
    this.z += Math.sin(heading) * CAR_SPEED * dt;
    this.heading = heading;
    this.elapsed += dt;

    // Leaving the road ends the run before any scoring is considered.
    if (distanceToCenterline(this.x, this.z) > MAX_CENTERLINE_DISTANCE) {
      this.state = "crashed";
      this.steering = false;
      this.crashX = this.x;
      this.crashZ = this.z;
      this.events.push({ type: "crash", x: this.x, z: this.z });
      return;
    }

    // Only the next checkpoint in order can score, in the forward direction
    // and while the car is on the road.
    const gate = GATES[this.nextIndex];
    const prev: Vec2 = { x: this.prevX, z: this.prevZ };
    const cur: Vec2 = { x: this.x, z: this.z };
    if (
      distanceToCenterline(this.x, this.z) <= MAX_CENTERLINE_DISTANCE &&
      crossedGateForward(prev, cur, gate)
    ) {
      this.points += 1;
      this.events.push({ type: "checkpoint", checkpoint: this.nextIndex + 1, points: this.points });
      const wasFinish = this.nextIndex === CHECKPOINT_COUNT - 1;
      this.nextIndex = (this.nextIndex + 1) % CHECKPOINT_COUNT;
      if (wasFinish) {
        this.laps += 1;
        this.events.push({ type: "lap", laps: this.laps, points: this.points });
      }
    }
  }

  /** Read-only view for rendering, HUD and tests. */
  getSnapshot(): SimSnapshot {
    return {
      state: this.state,
      x: this.x,
      z: this.z,
      heading: this.heading,
      prevX: this.prevX,
      prevZ: this.prevZ,
      prevHeading: this.prevHeading,
      steering: this.steering,
      points: this.points,
      laps: this.laps,
      nextCheckpoint: this.nextIndex + 1,
      elapsed: this.elapsed,
      crashX: this.crashX,
      crashZ: this.crashZ,
    };
  }

  /** Take the events accumulated since the last drain. */
  drainEvents(): SimEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }
}
