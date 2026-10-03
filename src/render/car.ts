/**
 * Tiny Apex — the race car. A small low-poly toy built from primitives and
 * extruded shapes. Purely visual: position and heading come from the
 * simulation snapshot; the drift yaw, body lean, wheel spin and front-wheel
 * steer angle are cosmetic and never affect collision or steering rules.
 */

import * as THREE from "three";
import type { SimSnapshot } from "../sim/game";

/** Top surface of the asphalt; the car and road effects sit on this plane. */
export const ROAD_SURFACE_Y = 0.05;

const WHEEL_RADIUS = 0.16;
const WHEEL_Z = 0.27;
const AXLE_X = 0.32;

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Tiny Apex: 2D canvas is unavailable");
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Cream roundel with a racing number for the doors. */
function roundelTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#f7eed7";
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.46, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2b2119";
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.fillStyle = "#2b2119";
    ctx.font = "800 76px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("7", w / 2, h / 2 + 4);
  });
}

export class Car {
  readonly group = new THREE.Group();
  private readonly bodyGroup = new THREE.Group();
  private readonly frontPivots: THREE.Group[] = [];
  private readonly spinners: THREE.Group[] = [];
  private yawOffset = 0;
  private lean = 0;
  private wheelAngle = 0;
  private steerAngle = 0;

  constructor() {
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: "#f7b71c",
      roughness: 0.45,
      metalness: 0.05,
      flatShading: true,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({
      color: "#26262c",
      roughness: 0.75,
      metalness: 0.05,
      flatShading: true,
    });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: "#2c3a44",
      roughness: 0.22,
      metalness: 0.25,
      flatShading: true,
    });
    const creamMaterial = new THREE.MeshStandardMaterial({
      color: "#f7eed7",
      roughness: 0.6,
      flatShading: true,
    });
    const tealMaterial = new THREE.MeshStandardMaterial({
      color: "#28a396",
      roughness: 0.5,
      flatShading: true,
    });
    const tireMaterial = new THREE.MeshStandardMaterial({
      color: "#232326",
      roughness: 0.9,
      flatShading: true,
    });

    // --- Body: a low extruded silhouette with a bevel for a toy-like edge.
    const bodyShape = new THREE.Shape();
    bodyShape.moveTo(-0.52, 0.06);
    bodyShape.lineTo(0.52, 0.06);
    bodyShape.lineTo(0.52, 0.15);
    bodyShape.lineTo(0.34, 0.21);
    bodyShape.lineTo(-0.34, 0.21);
    bodyShape.lineTo(-0.52, 0.17);
    bodyShape.closePath();
    const bodyGeometry = new THREE.ExtrudeGeometry(bodyShape, {
      depth: 0.5,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 1,
    });
    bodyGeometry.translate(0, 0, -0.25);
    const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
    body.castShadow = true;
    this.bodyGroup.add(body);

    // --- Cabin: dark glass greenhouse with a teal roof plate.
    const cabinShape = new THREE.Shape();
    cabinShape.moveTo(-0.3, 0.19);
    cabinShape.lineTo(0.16, 0.19);
    cabinShape.lineTo(0.03, 0.39);
    cabinShape.lineTo(-0.2, 0.39);
    cabinShape.closePath();
    const cabinGeometry = new THREE.ExtrudeGeometry(cabinShape, {
      depth: 0.36,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 1,
    });
    cabinGeometry.translate(0, 0, -0.18);
    const cabin = new THREE.Mesh(cabinGeometry, glassMaterial);
    cabin.castShadow = true;
    this.bodyGroup.add(cabin);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.03, 0.36), tealMaterial);
    roof.position.set(-0.085, 0.405, 0);
    roof.castShadow = true;
    this.bodyGroup.add(roof);

    // Centre racing stripe over the roof and hood so the car reads at a glance.
    const roofStripe = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.12), creamMaterial);
    roofStripe.position.set(-0.085, 0.425, 0);
    this.bodyGroup.add(roofStripe);
    const hoodStripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.12), creamMaterial);
    hoodStripe.position.set(0.26, 0.225, 0);
    this.bodyGroup.add(hoodStripe);

    // --- Details: hood stripe, splitter, headlights, spoiler, door roundels.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.1), creamMaterial);
    stripe.position.set(0.34, 0.24, 0);
    this.bodyGroup.add(stripe);

    const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 0.36), darkMaterial);
    splitter.position.set(0.5, 0.075, 0);
    this.bodyGroup.add(splitter);

    for (const side of [-1, 1]) {
      const light = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.1), creamMaterial);
      light.position.set(0.525, 0.16, side * 0.14);
      this.bodyGroup.add(light);

      const post = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.14, 0.03), darkMaterial);
      post.position.set(-0.46, 0.28, side * 0.13);
      this.bodyGroup.add(post);

      const roundel = new THREE.Mesh(
        new THREE.PlaneGeometry(0.2, 0.2),
        new THREE.MeshStandardMaterial({
          map: roundelTexture(),
          transparent: true,
          roughness: 0.6,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      );
      roundel.position.set(-0.02, 0.155, side * 0.272);
      roundel.rotation.y = side > 0 ? 0 : Math.PI;
      this.bodyGroup.add(roundel);
    }

    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.42), darkMaterial);
    wing.position.set(-0.5, 0.365, 0);
    wing.castShadow = true;
    this.bodyGroup.add(wing);

    this.group.add(this.bodyGroup);

    // --- Wheels: cylinders on Z axles, hex hubs and crossed spokes so the
    // spin reads clearly. Front wheels sit in pivots for the cosmetic steer.
    const tireGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.11, 12);
    tireGeometry.rotateX(Math.PI / 2);
    const hubGeometry = new THREE.CylinderGeometry(0.078, 0.078, 0.115, 6);
    hubGeometry.rotateX(Math.PI / 2);
    const spokeGeometry = new THREE.BoxGeometry(0.15, 0.022, 0.022);

    const makeWheel = (): THREE.Group => {
      const spinner = new THREE.Group();
      const tire = new THREE.Mesh(tireGeometry, tireMaterial);
      tire.castShadow = true;
      spinner.add(tire);
      const hub = new THREE.Mesh(hubGeometry, creamMaterial);
      spinner.add(hub);
      for (const side of [-1, 1]) {
        const spoke = new THREE.Mesh(spokeGeometry, darkMaterial);
        spoke.position.z = side * 0.06;
        spinner.add(spoke);
        const cross = new THREE.Mesh(spokeGeometry, darkMaterial);
        cross.position.z = side * 0.06;
        cross.rotation.z = Math.PI / 2;
        spinner.add(cross);
      }
      return spinner;
    };

    for (const side of [-1, 1]) {
      for (const front of [true, false]) {
        const spinner = makeWheel();
        if (front) {
          const pivot = new THREE.Group();
          pivot.position.set(AXLE_X, WHEEL_RADIUS, side * WHEEL_Z);
          pivot.add(spinner);
          this.group.add(pivot);
          this.frontPivots.push(pivot);
        } else {
          spinner.position.set(-AXLE_X, WHEEL_RADIUS, side * WHEEL_Z);
          this.group.add(spinner);
        }
        this.spinners.push(spinner);
      }
    }

    // --- Soft contact shadow blob (a second, cheap "shadow" for grounding).
    const blobTexture = canvasTexture(128, 128, (ctx, w, h) => {
      const gradient = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
      gradient.addColorStop(0, "rgba(46,30,18,0.5)");
      gradient.addColorStop(0.65, "rgba(46,30,18,0.28)");
      gradient.addColorStop(1, "rgba(46,30,18,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    });
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 1.15),
      new THREE.MeshBasicMaterial({
        map: blobTexture,
        transparent: true,
        depthWrite: false,
      }),
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    blob.renderOrder = 2;
    this.group.add(blob);

    // Scaled up slightly (still inside the 0.65 collision radius) so the car
    // stays readable when the whole circuit is framed on a phone screen.
    this.group.scale.setScalar(1.2);
    this.group.position.set(0, ROAD_SURFACE_Y, 0);
  }

  /**
   * @param movedDistance world units travelled since the last frame (wheel spin)
   */
  update(snapshot: SimSnapshot, dt: number, movedDistance: number, reducedMotion: boolean): void {
    this.group.position.set(snapshot.x, ROAD_SURFACE_Y, snapshot.z);

    const turning = snapshot.state === "racing" && snapshot.steering;
    const targetYaw = turning && !reducedMotion ? 0.16 : 0;
    const targetLean = turning && !reducedMotion ? -0.075 : 0;
    const targetSteer = turning && !reducedMotion ? 0.3 : 0;
    this.yawOffset = damp(this.yawOffset, targetYaw, 7, dt);
    this.lean = damp(this.lean, targetLean, 7, dt);
    this.steerAngle = damp(this.steerAngle, targetSteer, 10, dt);

    this.group.rotation.y = -(snapshot.heading + this.yawOffset);
    this.bodyGroup.rotation.x = this.lean;
    for (const pivot of this.frontPivots) pivot.rotation.y = -this.steerAngle;

    // Wheels roll forward; the visual rate is capped so the hubs stay readable.
    const spin = Math.min(movedDistance / WHEEL_RADIUS, 13 * dt);
    this.wheelAngle -= spin;
    for (const spinner of this.spinners) spinner.rotation.z = this.wheelAngle;
  }
}
