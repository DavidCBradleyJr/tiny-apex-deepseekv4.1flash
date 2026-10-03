/**
 * Tiny Apex — track definition.
 *
 * A stadium circuit on the flat XZ plane: two 14-unit straight centerline
 * segments joined by two semicircles of radius 8. The road is 4 units wide,
 * centered on that path. The car drives clockwise as viewed from above
 * (screen down = +Z), so heading increases while steering.
 *
 * Pure geometry — no DOM, no Three.js, deterministic.
 */

export const ROAD_HALF_WIDTH = 2; // full drivable width is 4
export const STRAIGHT_LENGTH = 14;
export const CORNER_RADIUS = 8;
export const HALF_CIRCLE_LENGTH = Math.PI * CORNER_RADIUS;
export const LAP_LENGTH = 2 * STRAIGHT_LENGTH + 2 * HALF_CIRCLE_LENGTH;
export const CHECKPOINT_COUNT = 8;
export const CAR_RADIUS = 0.65;
export const CAR_SPEED = 8; // world units per second, constant while racing
export const TURN_RATE = 1; // radians per second, clockwise from above

/** Arc centers sit on the X axis at ±STRAIGHT_LENGTH / 2. */
const ARC_CENTER_X = STRAIGHT_LENGTH / 2;
const TAU = Math.PI * 2;

export interface Vec2 {
  x: number;
  z: number;
}

export interface Pose {
  x: number;
  z: number;
  heading: number;
}

export interface Gate {
  /** 0-based index; checkpoint number is index + 1. */
  index: number;
  /** Arc length of the gate along the centerline. */
  s: number;
  center: Vec2;
  /** Gate endpoints, exactly on the road edges. */
  a: Vec2;
  b: Vec2;
  /** Unit tangent of the racing line at the gate (forward direction). */
  normal: Vec2;
}

/** Wrap an arc-length value into [0, LAP_LENGTH). */
export function normalizeS(s: number): number {
  const m = s % LAP_LENGTH;
  return m < 0 ? m + LAP_LENGTH : m;
}

/** Position and heading at arc length s along the centerline. */
export function poseAt(s: number): Pose {
  const t = normalizeS(s);
  if (t < STRAIGHT_LENGTH) {
    // Bottom straight, driven +X.
    return { x: -ARC_CENTER_X + t, z: -CORNER_RADIUS, heading: 0 };
  }
  if (t < STRAIGHT_LENGTH + HALF_CIRCLE_LENGTH) {
    // Right semicircle around (ARC_CENTER_X, 0).
    const alpha = -Math.PI / 2 + (t - STRAIGHT_LENGTH) / CORNER_RADIUS;
    return {
      x: ARC_CENTER_X + CORNER_RADIUS * Math.cos(alpha),
      z: CORNER_RADIUS * Math.sin(alpha),
      heading: alpha + Math.PI / 2,
    };
  }
  if (t < 2 * STRAIGHT_LENGTH + HALF_CIRCLE_LENGTH) {
    // Top straight, driven -X.
    return {
      x: ARC_CENTER_X - (t - STRAIGHT_LENGTH - HALF_CIRCLE_LENGTH),
      z: CORNER_RADIUS,
      heading: Math.PI,
    };
  }
  // Left semicircle around (-ARC_CENTER_X, 0).
  const alpha = Math.PI / 2 + (t - 2 * STRAIGHT_LENGTH - HALF_CIRCLE_LENGTH) / CORNER_RADIUS;
  return {
    x: -ARC_CENTER_X + CORNER_RADIUS * Math.cos(alpha),
    z: CORNER_RADIUS * Math.sin(alpha),
    heading: alpha + Math.PI / 2,
  };
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const lengthSq = abx * abx + abz * abz;
  let t = lengthSq > 0 ? (apx * abx + apz * abz) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.hypot(dx, dz);
}

/**
 * Distance from a point to a circular arc, falling back to the nearest
 * endpoint when the point projects outside the arc's angular span.
 */
function distanceToArc(
  px: number,
  pz: number,
  cx: number,
  cz: number,
  radius: number,
  startAngle: number,
  endAngle: number,
): number {
  const dx = px - cx;
  const dz = pz - cz;
  const distance = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);
  let relative = (angle - startAngle) % TAU;
  if (relative < 0) relative += TAU;
  const span = endAngle - startAngle;
  if (relative <= span) {
    return Math.abs(distance - radius);
  }
  const ax = cx + radius * Math.cos(startAngle);
  const az = cz + radius * Math.sin(startAngle);
  const bx = cx + radius * Math.cos(endAngle);
  const bz = cz + radius * Math.sin(endAngle);
  return Math.min(Math.hypot(px - ax, pz - az), Math.hypot(px - bx, pz - bz));
}

/**
 * Shortest distance from a point to the closed centerline loop. This is the
 * collision metric: the car's circular footprint (radius CAR_RADIUS) must
 * stay inside the road, so the center may be at most
 * ROAD_HALF_WIDTH - CAR_RADIUS from the centerline. Both the inner and the
 * outer road edges are handled by construction.
 */
export function distanceToCenterline(px: number, pz: number): number {
  const bottomStraight = distanceToSegment(px, pz, -ARC_CENTER_X, -CORNER_RADIUS, ARC_CENTER_X, -CORNER_RADIUS);
  const topStraight = distanceToSegment(px, pz, ARC_CENTER_X, CORNER_RADIUS, -ARC_CENTER_X, CORNER_RADIUS);
  const rightArc = distanceToArc(px, pz, ARC_CENTER_X, 0, CORNER_RADIUS, -Math.PI / 2, Math.PI / 2);
  const leftArc = distanceToArc(px, pz, -ARC_CENTER_X, 0, CORNER_RADIUS, Math.PI / 2, (3 * Math.PI) / 2);
  return Math.min(bottomStraight, topStraight, rightArc, leftArc);
}

/** Center of a gate chord at arc length s, plus its forward tangent. */
function gateAt(s: number, index: number): Gate {
  const pose = poseAt(s);
  const nx = -Math.sin(pose.heading);
  const nz = Math.cos(pose.heading);
  return {
    index,
    s,
    center: { x: pose.x, z: pose.z },
    a: { x: pose.x - nx * ROAD_HALF_WIDTH, z: pose.z - nz * ROAD_HALF_WIDTH },
    b: { x: pose.x + nx * ROAD_HALF_WIDTH, z: pose.z + nz * ROAD_HALF_WIDTH },
    normal: { x: Math.cos(pose.heading), z: Math.sin(pose.heading) },
  };
}

/**
 * Eight checkpoints spaced evenly by distance around the centerline. The
 * eighth sits at the start/finish line (arc length 0). The gates span the
 * full road width, so any on-road pass must cross the chord.
 */
export const GATES: readonly Gate[] = Array.from({ length: CHECKPOINT_COUNT }, (_, i) =>
  gateAt(normalizeS(((i + 1) * LAP_LENGTH) / CHECKPOINT_COUNT), i),
);

function cross2(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

/** True when segment p1→p2 properly crosses segment p3→p4. */
export function segmentsCross(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = cross2(p4.x - p3.x, p4.z - p3.z, p1.x - p3.x, p1.z - p3.z);
  const d2 = cross2(p4.x - p3.x, p4.z - p3.z, p2.x - p3.x, p2.z - p3.z);
  const d3 = cross2(p2.x - p1.x, p2.z - p1.z, p3.x - p1.x, p3.z - p1.z);
  const d4 = cross2(p2.x - p1.x, p2.z - p1.z, p4.x - p1.x, p4.z - p1.z);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * True when the movement segment prev→cur crosses the gate in the forward
 * direction. Strict sign tests mean a segment starting exactly on the gate
 * line does not count as a crossing.
 */
export function crossedGateForward(prev: Vec2, cur: Vec2, gate: Gate): boolean {
  const moveX = cur.x - prev.x;
  const moveZ = cur.z - prev.z;
  if (moveX * gate.normal.x + moveZ * gate.normal.z <= 0) return false;
  return segmentsCross(prev, cur, gate.a, gate.b);
}
