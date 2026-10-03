/**
 * Tiny Apex — short-lived road effects: tire marks while steering and dust
 * puffs at the rear wheels, plus a dust burst on crash. Both are fixed-size
 * pools that recycle the oldest entry, so nothing can grow without bound.
 * Cosmetic only; the simulation never sees them.
 */

import * as THREE from "three";
import { ROAD_SURFACE_Y } from "./car";

const SKID_POOL = 96;
const DUST_POOL = 56;
const SKID_LIFE = 2.4;
const DUST_LIFE = 0.62;

interface SkidMark {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  life: number;
}

interface DustPuff {
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  velocity: THREE.Vector3;
  life: number;
  maxLife: number;
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
  return texture;
}

export class Effects {
  private readonly skids: SkidMark[] = [];
  private readonly dust: DustPuff[] = [];
  private skidCursor = 0;
  private dustCursor = 0;
  private skidTimer = 0;
  private dustTimer = 0;
  private seed = 987654321;

  constructor(private readonly scene: THREE.Scene) {
    const markTexture = canvasTexture(64, 64, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, "rgba(15,15,19,0)");
      gradient.addColorStop(0.35, "rgba(15,15,19,0.95)");
      gradient.addColorStop(0.65, "rgba(15,15,19,0.95)");
      gradient.addColorStop(1, "rgba(15,15,19,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    });
    const markGeometry = new THREE.PlaneGeometry(0.19, 0.5);
    markGeometry.rotateX(-Math.PI / 2);

    for (let i = 0; i < SKID_POOL; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: markTexture,
        transparent: true,
        depthWrite: false,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(markGeometry, material);
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.skids.push({ mesh, material, life: 0 });
    }

    const dustGeometry = new THREE.IcosahedronGeometry(0.09, 0);
    for (let i = 0; i < DUST_POOL; i++) {
      const material = new THREE.MeshStandardMaterial({
        color: "#e0c48d",
        roughness: 1,
        transparent: true,
        depthWrite: false,
        flatShading: true,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(dustGeometry, material);
      mesh.visible = false;
      this.scene.add(mesh);
      this.dust.push({ mesh, material, velocity: new THREE.Vector3(), life: 0, maxLife: DUST_LIFE });
    }
  }

  private random(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  /** Hide every effect and reset timers — used on restart. */
  reset(): void {
    this.seed = 987654321;
    this.skidTimer = 0;
    this.dustTimer = 0;
    for (const skid of this.skids) {
      skid.life = 0;
      skid.mesh.visible = false;
    }
    for (const puff of this.dust) {
      puff.life = 0;
      puff.mesh.visible = false;
    }
  }

  /**
   * Emit marks and dust while the player is steering. Called each frame with
   * the interpolated car pose; rear-wheel offsets are in car-local space.
   */
  emitSteering(x: number, z: number, heading: number, dt: number, reducedMotion: boolean): void {
    const rearX = x - Math.cos(heading) * 0.32;
    const rearZ = z - Math.sin(heading) * 0.32;
    const acrossX = -Math.sin(heading);
    const acrossZ = Math.cos(heading);

    this.skidTimer -= dt;
    if (this.skidTimer <= 0) {
      this.skidTimer = 0.055;
      for (const side of [-1, 1]) {
        this.spawnSkid(
          rearX + acrossX * side * 0.24,
          rearZ + acrossZ * side * 0.24,
          heading,
        );
      }
    }

    if (reducedMotion) return;
    this.dustTimer -= dt;
    if (this.dustTimer <= 0) {
      this.dustTimer = 0.075;
      for (const side of [-1, 1]) {
        this.spawnDust(
          rearX + acrossX * side * 0.26,
          rearZ + acrossZ * side * 0.26,
          (this.random() - 0.5) * 0.5,
          0.7 + this.random() * 0.5,
          (this.random() - 0.5) * 0.5,
        );
      }
    }
  }

  private spawnSkid(x: number, z: number, heading: number): void {
    const index = this.skidCursor;
    this.skidCursor = (this.skidCursor + 1) % SKID_POOL;
    const skid = this.skids[index];
    skid.mesh.position.set(x, ROAD_SURFACE_Y + 0.008, z);
    skid.mesh.rotation.y = -heading;
    skid.mesh.visible = true;
    skid.life = SKID_LIFE;
    skid.material.opacity = 0.7;
  }

  private spawnDust(x: number, z: number, vx: number, vy: number, vz: number): void {
    const index = this.dustCursor;
    this.dustCursor = (this.dustCursor + 1) % DUST_POOL;
    const puff = this.dust[index];
    puff.mesh.position.set(x, ROAD_SURFACE_Y + 0.1, z);
    puff.mesh.scale.setScalar(0.8 + this.random() * 0.5);
    puff.velocity.set(vx, vy, vz);
    puff.mesh.visible = true;
    puff.life = puff.maxLife;
    puff.material.opacity = 0.75;
  }

  /** A ring of dust where the run ended. */
  burst(x: number, z: number): void {
    const count = 16;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.random() * 0.3;
      const speed = 1.2 + this.random() * 1.6;
      const index = this.dustCursor;
      this.dustCursor = (this.dustCursor + 1) % DUST_POOL;
      const puff = this.dust[index];
      puff.mesh.position.set(x + Math.cos(angle) * 0.2, ROAD_SURFACE_Y + 0.12, z + Math.sin(angle) * 0.2);
      puff.mesh.scale.setScalar(0.9 + this.random() * 0.6);
      puff.velocity.set(Math.cos(angle) * speed, 0.9 + this.random() * 0.8, Math.sin(angle) * speed);
      puff.mesh.visible = true;
      puff.life = puff.maxLife * 1.5;
      puff.material.opacity = 0.85;
    }
  }

  /** Frame-rate independent fade/advance; called once per rendered frame. */
  update(dt: number): void {
    for (const skid of this.skids) {
      if (skid.life <= 0) continue;
      skid.life -= dt;
      if (skid.life <= 0) {
        skid.mesh.visible = false;
        skid.material.opacity = 0;
      } else {
        const t = skid.life / SKID_LIFE;
        skid.material.opacity = 0.7 * t * t;
      }
    }
    for (const puff of this.dust) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.mesh.visible = false;
        puff.material.opacity = 0;
        continue;
      }
      const t = puff.life / puff.maxLife;
      puff.mesh.position.addScaledVector(puff.velocity, dt);
      puff.velocity.multiplyScalar(Math.exp(-2.2 * dt));
      puff.velocity.y += 0.35 * dt;
      puff.mesh.scale.multiplyScalar(1 + 1.6 * dt);
      puff.material.opacity = 0.8 * t * t;
    }
  }

  /** Number of visible marks/puffs — used by tests to prove pools stay bounded. */
  activeCounts(): { skids: number; dust: number } {
    let skids = 0;
    let dust = 0;
    for (const skid of this.skids) if (skid.life > 0) skids++;
    for (const puff of this.dust) if (puff.life > 0) dust++;
    return { skids, dust };
  }
}
