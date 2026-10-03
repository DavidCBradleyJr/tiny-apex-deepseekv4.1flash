/**
 * Tiny Apex — the rendered world. Builds the sculpted desert base, the
 * stadium circuit, low-poly scenery and the checkpoint markers, and owns the
 * renderer, lights and fitted camera. Everything visible is authored here
 * from Three.js primitives, extruded shapes and canvas textures.
 *
 * The world only reads simulation snapshots; it never changes game state.
 */

import * as THREE from "three";

import {
  GATES,
  LAP_LENGTH,
  distanceToCenterline,
  poseAt,
} from "../sim/track";
import type { SimSnapshot } from "../sim/game";
import { Car, ROAD_SURFACE_Y } from "./car";
import { Effects } from "./effects";

const BASE_HALF_X = 19;
const BASE_HALF_Z = 13;
const BASE_CORNER = 5;
const BASE_DEPTH = 1.5;

const CREAM = "#f7eed7";
const TERRACOTTA = "#c05f3c";
const TERRACOTTA_DEEP = "#96422a";
const DARK = "#2b2119";

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

/** Deterministic PRNG so the scenery is identical on every load. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckleTexture(base: string, dots: string[]): THREE.CanvasTexture {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    const rng = mulberry32(4242);
    for (let i = 0; i < 700; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const r = 0.6 + rng() * 1.7;
      ctx.fillStyle = dots[Math.floor(rng() * dots.length)];
      ctx.globalAlpha = 0.25 + rng() * 0.45;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
}

function roundedRectShape(halfX: number, halfZ: number, corner: number): THREE.Shape {
  const shape = new THREE.Shape();
  shape.moveTo(-halfX + corner, -halfZ);
  shape.lineTo(halfX - corner, -halfZ);
  shape.absarc(halfX - corner, -halfZ + corner, corner, -Math.PI / 2, 0, false);
  shape.lineTo(halfX, halfZ - corner);
  shape.absarc(halfX - corner, halfZ - corner, corner, 0, Math.PI / 2, false);
  shape.lineTo(-halfX + corner, halfZ);
  shape.absarc(-halfX + corner, halfZ - corner, corner, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfX, -halfZ + corner);
  shape.absarc(-halfX + corner, -halfZ + corner, corner, Math.PI, Math.PI * 1.5, false);
  return shape;
}

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly car = new Car();
  readonly effects: Effects;

  private readonly nextGroup = new THREE.Group();
  private readonly diamonds: THREE.Mesh[] = [];
  private readonly crashRing: THREE.Mesh;
  private readonly crashRingMaterial: THREE.MeshBasicMaterial;
  private readonly crashBeacon: THREE.Mesh;
  private readonly crashBeaconMaterial: THREE.MeshBasicMaterial;
  private nextGateIndex = -1;
  private time = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene.background = canvasTexture(4, 256, (ctx, w, h) => {
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, "#fdf6e2");
      gradient.addColorStop(0.55, "#f7e6c2");
      gradient.addColorStop(1, "#eed0a0");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);
    });

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 400);

    this.buildLights();
    this.buildBase();
    this.buildRoad();
    this.buildEdgeLines();
    this.buildCurbsAndDashes();
    this.buildStartLine();
    this.buildGantry();
    this.buildBillboard();
    this.buildChevronSigns();
    this.buildArch();
    this.buildLandmarks();
    this.buildScenery();
    this.buildCheckpoints();

    this.effects = new Effects(this.scene);
    this.scene.add(this.car.group);

    const ringGeometry = new THREE.RingGeometry(0.85, 1.12, 40);
    ringGeometry.rotateX(-Math.PI / 2);
    this.crashRingMaterial = new THREE.MeshBasicMaterial({
      color: "#d8432f",
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.crashRing = new THREE.Mesh(ringGeometry, this.crashRingMaterial);
    this.crashRing.position.y = ROAD_SURFACE_Y + 0.02;
    this.crashRing.visible = false;
    this.crashRing.renderOrder = 3;
    this.scene.add(this.crashRing);

    // A slim translucent column so the crash point is obvious even when the
    // car itself is hidden behind the marker or seen from across the circuit.
    this.crashBeaconMaterial = new THREE.MeshBasicMaterial({
      color: "#e0503a",
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.crashBeacon = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.34, 2.2, 10, 1, true),
      this.crashBeaconMaterial,
    );
    this.crashBeacon.position.y = ROAD_SURFACE_Y + 1.1;
    this.crashBeacon.visible = false;
    this.crashBeacon.renderOrder = 3;
    this.scene.add(this.crashBeacon);

    this.fitCamera();
  }

  // ------------------------------------------------------------------ lights

  private buildLights(): void {
    const hemisphere = new THREE.HemisphereLight("#fff3da", "#c08a58", 0.75);
    this.scene.add(hemisphere);

    const key = new THREE.DirectionalLight("#ffe6bd", 2.1);
    key.position.set(16, 26, 11);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const shadowCamera = key.shadow.camera;
    shadowCamera.left = -24;
    shadowCamera.right = 24;
    shadowCamera.top = 24;
    shadowCamera.bottom = -24;
    shadowCamera.near = 2;
    shadowCamera.far = 70;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.03;
    this.scene.add(key);
    this.scene.add(key.target);

    const fill = new THREE.DirectionalLight("#cfe0ff", 0.35);
    fill.position.set(-14, 12, -10);
    this.scene.add(fill);
  }

  // -------------------------------------------------------------------- base

  private buildBase(): void {
    const sandTexture = speckleTexture("#e9d2a2", ["#f6e6c2", "#d8ba86", "#c9a878"]);
    sandTexture.wrapS = THREE.RepeatWrapping;
    sandTexture.wrapT = THREE.RepeatWrapping;
    sandTexture.repeat.set(5, 3.4);

    const topMaterial = new THREE.MeshStandardMaterial({
      color: "#e9d2a2",
      map: sandTexture,
      roughness: 0.95,
      metalness: 0,
    });
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: "#a9552f",
      roughness: 0.9,
      metalness: 0,
    });
    const bevel = 0.12;
    const geometry = new THREE.ExtrudeGeometry(roundedRectShape(BASE_HALF_X, BASE_HALF_Z, BASE_CORNER), {
      depth: BASE_DEPTH,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 1,
    });
    // A bevelled ExtrudeGeometry extends bevelThickness past the cap on both
    // ends, so shift by the full extent to land the sand surface at y = 0.
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, -(BASE_DEPTH + bevel), 0);
    const base = new THREE.Mesh(geometry, [topMaterial, sideMaterial]);
    base.receiveShadow = true;
    base.castShadow = true;
    this.scene.add(base);
  }

  // -------------------------------------------------------------------- road

  private buildRoad(): void {
    const samples = 560;
    const columns = [-2, -1.2, -0.4, 0.4, 1.2, 2];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= samples; i++) {
      const s = (i / samples) * LAP_LENGTH;
      const pose = poseAt(s);
      const acrossX = -Math.sin(pose.heading);
      const acrossZ = Math.cos(pose.heading);
      for (const lateral of columns) {
        positions.push(pose.x + acrossX * lateral, ROAD_SURFACE_Y, pose.z + acrossZ * lateral);
        normals.push(0, 1, 0);
        uvs.push((lateral + 2) / 4, s / 4);
        const shade = 0.94 + 0.06 * Math.sin(s * 1.7 + lateral * 2.1);
        colors.push(shade, shade, shade);
      }
    }
    const row = columns.length;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < row - 1; j++) {
        const a = i * row + j;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        // Wound so the face normal points up (+Y): rows advance along the
        // track (+x locally), columns advance across it (+z locally).
        indices.push(a, b, c, b, d, c);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);

    const asphalt = speckleTexture("#ffffff", ["#b9b9c4", "#ffffff", "#8f8f9c"]);
    asphalt.wrapS = THREE.RepeatWrapping;
    asphalt.wrapT = THREE.RepeatWrapping;

    const material = new THREE.MeshStandardMaterial({
      color: "#3d3d46",
      map: asphalt,
      roughness: 0.96,
      metalness: 0.02,
      vertexColors: true,
    });
    const road = new THREE.Mesh(geometry, material);
    road.receiveShadow = true;
    this.scene.add(road);
  }

  /**
   * Painted cream edge lines just inside the asphalt: two thin ribbons in one
   * geometry, sampled from the same track definition as the road.
   */
  private buildEdgeLines(): void {
    const samples = 560;
    const strips: [number, number][] = [
      [-1.92, -1.66],
      [1.66, 1.92],
    ];
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexBase = 0;
    for (const [inner, outer] of strips) {
      for (let i = 0; i <= samples; i++) {
        const s = (i / samples) * LAP_LENGTH;
        const pose = poseAt(s);
        const acrossX = -Math.sin(pose.heading);
        const acrossZ = Math.cos(pose.heading);
        for (const lateral of [inner, outer]) {
          positions.push(
            pose.x + acrossX * lateral,
            ROAD_SURFACE_Y + 0.012,
            pose.z + acrossZ * lateral,
          );
          normals.push(0, 1, 0);
          uvs.push(0, s / 2);
        }
      }
      for (let i = 0; i < samples; i++) {
        const a = vertexBase + i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        indices.push(a, b, c, b, d, c);
      }
      vertexBase += (samples + 1) * 2;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const lines = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: "#efe0bd", roughness: 0.85, metalness: 0 }),
    );
    lines.receiveShadow = true;
    this.scene.add(lines);
  }

  private buildCurbsAndDashes(): void {
    const curbGeometry = new THREE.BoxGeometry(0.5, 0.12, 1.5);
    const curbMaterial = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      roughness: 0.85,
      flatShading: true,
    });
    const step = 1.62;
    const perEdge = Math.floor(LAP_LENGTH / step);
    const curbs = new THREE.InstancedMesh(curbGeometry, curbMaterial, perEdge * 2);
    const dummy = new THREE.Object3D();
    const colorA = new THREE.Color(TERRACOTTA);
    const colorB = new THREE.Color(CREAM);
    let index = 0;
    for (const side of [-1, 1]) {
      for (let i = 0; i < perEdge; i++) {
        const pose = poseAt((i + 0.5) * step);
        const nx = -Math.sin(pose.heading);
        const nz = Math.cos(pose.heading);
        dummy.position.set(pose.x + nx * side * 2.25, 0.06, pose.z + nz * side * 2.25);
        dummy.rotation.set(0, Math.PI / 2 - pose.heading, 0);
        dummy.updateMatrix();
        curbs.setMatrixAt(index, dummy.matrix);
        curbs.setColorAt(index, i % 2 === 0 ? colorA : colorB);
        index++;
      }
    }
    curbs.instanceMatrix.needsUpdate = true;
    if (curbs.instanceColor) curbs.instanceColor.needsUpdate = true;
    curbs.castShadow = true;
    curbs.receiveShadow = true;
    this.scene.add(curbs);

    const dashGeometry = new THREE.BoxGeometry(0.22, 0.02, 1.0);
    const dashMaterial = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.8 });
    const dashStep = 2.4;
    const dashCount = Math.floor(LAP_LENGTH / dashStep);
    const dashes = new THREE.InstancedMesh(dashGeometry, dashMaterial, dashCount);
    for (let i = 0; i < dashCount; i++) {
      const pose = poseAt((i + 0.5) * dashStep);
      dummy.position.set(pose.x, ROAD_SURFACE_Y + 0.015, pose.z);
      dummy.rotation.set(0, Math.PI / 2 - pose.heading, 0);
      dummy.updateMatrix();
      dashes.setMatrixAt(i, dummy.matrix);
    }
    dashes.instanceMatrix.needsUpdate = true;
    this.scene.add(dashes);
  }

  private buildStartLine(): void {
    const texture = canvasTexture(256, 64, (ctx, w, h) => {
      const cols = 8;
      const rows = 2;
      const cw = w / cols;
      const ch = h / rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? "#f7eed7" : "#2b2119";
          ctx.fillRect(x * cw, y * ch, cw, ch);
        }
      }
    });
    const geometry = new THREE.PlaneGeometry(1.4, 4);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8 }),
    );
    const pose = poseAt(0);
    mesh.position.set(pose.x, ROAD_SURFACE_Y + 0.018, pose.z);
    mesh.rotation.y = -pose.heading;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  private buildGantry(): void {
    const pose = poseAt(1.6);
    const group = new THREE.Group();
    group.position.set(pose.x, 0, pose.z);

    const postMaterial = new THREE.MeshStandardMaterial({ color: TERRACOTTA_DEEP, roughness: 0.85 });
    const beamMaterial = new THREE.MeshStandardMaterial({ color: TERRACOTTA, roughness: 0.8 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.3, 0.16), postMaterial);
      post.position.set(0, 1.15, side * 3.05);
      post.castShadow = true;
      group.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 6.6), beamMaterial);
    beam.position.set(0, 2.42, 0);
    beam.castShadow = true;
    group.add(beam);
    const trimMaterial = new THREE.MeshStandardMaterial({ color: "#1f8a80", roughness: 0.6 });
    for (const side of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.14), trimMaterial);
      cap.position.set(0, 2.42, side * 3.32);
      cap.castShadow = true;
      group.add(cap);
    }

    const banner = canvasTexture(512, 128, (ctx, w, h) => {
      ctx.fillStyle = CREAM;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = TERRACOTTA;
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, w - 10, h - 10);
      ctx.fillStyle = DARK;
      ctx.font = "800 58px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("TINY APEX", w / 2, h / 2 - 4);
      ctx.fillStyle = "#1f8a80";
      ctx.fillRect(w / 2 - 110, h - 26, 220, 6);
    });
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 0.86),
      new THREE.MeshStandardMaterial({ map: banner, roughness: 0.7, side: THREE.DoubleSide }),
    );
    sign.position.set(-0.17, 2.42, 0);
    sign.rotation.y = -Math.PI / 2;
    group.add(sign);
    this.scene.add(group);
  }

  private buildBillboard(): void {
    const texture = canvasTexture(512, 192, (ctx, w, h) => {
      ctx.fillStyle = CREAM;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = TERRACOTTA;
      ctx.lineWidth = 12;
      ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = DARK;
      ctx.font = "800 68px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("TINY APEX", w / 2, h / 2 - 18);
      ctx.font = "700 26px system-ui, sans-serif";
      ctx.fillStyle = "#1f8a80";
      ctx.fillText("HOLD TO TURN", w / 2, h / 2 + 42);
      const squares = 10;
      const size = 16;
      const startX = (w - squares * size) / 2;
      for (let i = 0; i < squares; i++) {
        ctx.fillStyle = i % 2 === 0 ? DARK : CREAM;
        ctx.fillRect(startX + i * size, h - 6 - size, size, size);
      }
    });
    const group = new THREE.Group();
    group.position.set(0, 0, -3.8);
    group.rotation.y = 0.3;
    const postMaterial = new THREE.MeshStandardMaterial({ color: TERRACOTTA_DEEP, roughness: 0.85 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.15, 0.12), postMaterial);
      post.position.set(side * 0.95, 0.575, 0);
      post.castShadow = true;
      group.add(post);
    }
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 0.95),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7, side: THREE.DoubleSide }),
    );
    board.position.set(0, 1.35, 0.01);
    board.castShadow = true;
    group.add(board);
    this.scene.add(group);
  }

  private buildChevronSigns(): void {
    const texture = canvasTexture(256, 128, (ctx, w, h) => {
      ctx.fillStyle = CREAM;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = TERRACOTTA_DEEP;
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, w - 10, h - 10);
      ctx.strokeStyle = TERRACOTTA;
      ctx.lineWidth = 20;
      ctx.lineJoin = "miter";
      for (const x of [46, 108, 170]) {
        ctx.beginPath();
        ctx.moveTo(x, 26);
        ctx.lineTo(x + 38, 64);
        ctx.lineTo(x, 102);
        ctx.stroke();
      }
    });
    const boardGeometry = new THREE.PlaneGeometry(1.9, 0.95);
    const boardMaterial = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
    const postMaterial = new THREE.MeshStandardMaterial({ color: TERRACOTTA_DEEP, roughness: 0.85 });

    const place = (x: number, z: number, rotationY: number): void => {
      const group = new THREE.Group();
      group.position.set(x, 0, z);
      group.rotation.y = rotationY;
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.1), postMaterial);
        post.position.set(side * 0.7, 0.675, 0);
        post.castShadow = true;
        group.add(post);
      }
      const board = new THREE.Mesh(boardGeometry, boardMaterial);
      board.position.set(0, 1.25, 0);
      board.castShadow = true;
      group.add(board);
      this.scene.add(group);
    };

    // Entry of the right-hand corner, outside the bottom straight.
    place(4.5, -12.0, -Math.PI / 2);
    // Entry of the left-hand corner, outside the top straight.
    place(-4.5, 12.0, Math.PI / 2);
  }

  /**
   * A handful of deliberate landmarks: a stepped grandstand by the finish, a
   * paddock hut and a small oasis in the infield, and teal pennants on the
   * rim. All decorative — the simulation never consults them.
   */
  private buildLandmarks(): void {
    const cream = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.85 });
    const terracotta = new THREE.MeshStandardMaterial({ color: TERRACOTTA, roughness: 0.85 });
    const deep = new THREE.MeshStandardMaterial({ color: TERRACOTTA_DEEP, roughness: 0.9 });
    const teal = new THREE.MeshStandardMaterial({ color: "#1f8a80", roughness: 0.6 });

    // --- Grandstand outside the start/finish straight.
    const stand = new THREE.Group();
    stand.position.set(-1.2, 0, -12.7);
    for (let i = 0; i < 3; i++) {
      const tier = new THREE.Mesh(
        new THREE.BoxGeometry(5.4, 0.34, 1.5),
        i % 2 === 0 ? cream : terracotta,
      );
      tier.position.set(0, 0.17 + i * 0.34, -i * 0.72);
      tier.castShadow = true;
      tier.receiveShadow = true;
      stand.add(tier);
    }
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.14, 2.4), teal);
    canopy.position.set(0, 1.72, -0.72);
    canopy.castShadow = true;
    stand.add(canopy);
    const postGeometry = new THREE.BoxGeometry(0.11, 1.7, 0.11);
    for (const x of [-2.6, 2.6]) {
      for (const z of [0.35, -1.8]) {
        const post = new THREE.Mesh(postGeometry, deep);
        post.position.set(x, 0.85, z);
        post.castShadow = true;
        stand.add(post);
      }
    }
    this.scene.add(stand);

    // --- Paddock hut in the infield.
    const paddock = new THREE.Group();
    paddock.position.set(4.4, 0, 3.0);
    paddock.rotation.y = -0.42;
    const walls = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 1.7), cream);
    walls.position.y = 0.55;
    walls.castShadow = true;
    walls.receiveShadow = true;
    paddock.add(walls);
    const hutRoof = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.16, 2.0), teal);
    hutRoof.position.y = 1.18;
    hutRoof.rotation.z = 0.06;
    hutRoof.castShadow = true;
    paddock.add(hutRoof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.5), deep);
    door.position.set(1.21, 0.32, 0);
    paddock.add(door);
    this.scene.add(paddock);

    // --- Small oasis in the infield.
    const oasis = new THREE.Group();
    oasis.position.set(-3.6, 0, 2.8);
    const rim = new THREE.Mesh(
      new THREE.CircleGeometry(2.1, 26),
      new THREE.MeshStandardMaterial({ color: "#d9b97f", roughness: 1 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.012;
    rim.receiveShadow = true;
    oasis.add(rim);
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(1.7, 26),
      new THREE.MeshStandardMaterial({ color: "#2aa79b", roughness: 0.32, metalness: 0.05 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.022;
    oasis.add(water);
    this.scene.add(oasis);

    // --- Teal pennants on the four rim corners.
    const poleGeometry = new THREE.CylinderGeometry(0.035, 0.045, 1.25, 6);
    const flagGeometry = new THREE.ConeGeometry(0.16, 0.34, 3);
    for (const [x, z] of [
      [-16.6, -11.2],
      [16.6, -11.2],
      [-16.6, 11.2],
      [16.6, 11.2],
    ] as [number, number][]) {
      const pole = new THREE.Mesh(poleGeometry, cream);
      pole.position.set(x, 0.62, z);
      pole.castShadow = true;
      this.scene.add(pole);
      const flag = new THREE.Mesh(flagGeometry, teal);
      flag.rotation.z = -Math.PI / 2;
      flag.position.set(x + 0.17, 1.1, z);
      flag.castShadow = true;
      this.scene.add(flag);
    }
  }

  private buildArch(): void {
    const group = new THREE.Group();
    group.position.set(1.8, 0, 0.8);
    group.rotation.y = 0.35;
    const material = new THREE.MeshStandardMaterial({ color: TERRACOTTA_DEEP, roughness: 0.9, flatShading: true });
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.0, 0.5), material);
      pillar.position.set(side * 1.35, 1.0, 0);
      pillar.castShadow = true;
      pillar.receiveShadow = true;
      group.add(pillar);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 0.6), material);
    lintel.position.set(0, 2.15, 0);
    lintel.castShadow = true;
    group.add(lintel);
    const accent = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.12, 0.62),
      new THREE.MeshStandardMaterial({ color: "#1f8a80", roughness: 0.6 }),
    );
    accent.position.set(0, 1.92, 0);
    group.add(accent);
    this.scene.add(group);
  }

  // ----------------------------------------------------------------- scenery

  private buildScenery(): void {
    const rng = mulberry32(20261002);
    const occupied: { x: number; z: number; r: number }[] = [
      { x: 0, z: -3.8, r: 2.6 }, // billboard
      { x: 1.8, z: 0.8, r: 2.8 }, // arch
      { x: -5.4, z: -8, r: 3.6 }, // gantry
      { x: 4.5, z: -12.0, r: 2.2 },
      { x: -4.5, z: 12.0, r: 2.2 },
      { x: -1.2, z: -12.7, r: 4.0 }, // grandstand
      { x: 4.4, z: 3.0, r: 3.0 }, // paddock hut
      { x: -3.6, z: 2.8, r: 3.0 }, // oasis
    ];
    const place = (minRoad: number, spacing: number): { x: number; z: number } | null => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const x = (rng() * 2 - 1) * 17.2;
        const z = (rng() * 2 - 1) * 11.2;
        if (distanceToCenterline(x, z) < minRoad) continue;
        if (occupied.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + spacing)) continue;
        occupied.push({ x, z, r: spacing });
        return { x, z };
      }
      return null;
    };

    const rockGeometries = [
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.OctahedronGeometry(1, 1),
    ];
    const rockMaterials = ["#b0603f", "#8f5a3d", "#c98a5e"].map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }),
    );
    const addRock = (x: number, z: number, scale: number, squash: number): void => {
      const mesh = new THREE.Mesh(
        rockGeometries[Math.floor(rng() * rockGeometries.length)],
        rockMaterials[Math.floor(rng() * rockMaterials.length)],
      );
      mesh.position.set(x, scale * squash * 0.45, z);
      mesh.scale.set(scale, scale * squash, scale * (0.8 + rng() * 0.4));
      mesh.rotation.set(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    };

    for (let i = 0; i < 14; i++) {
      const spot = place(3.7, 1.4);
      if (spot) addRock(spot.x, spot.z, 0.22 + rng() * 0.34, 0.6 + rng() * 0.5);
    }
    const bigRocks: [number, number, number][] = [
      [-16.8, -10.2, 1.15],
      [16.4, -10.6, 0.95],
      [16.9, 10.3, 1.25],
      [-16.2, 10.6, 0.9],
      [-14.6, -11.4, 0.7],
      [14.9, 11.5, 0.75],
    ];
    for (const [x, z, scale] of bigRocks) addRock(x, z, scale, 0.75);

    // Saguaro cacti — deep teal-green, kept well away from the racing line.
    const cactusMaterial = new THREE.MeshStandardMaterial({
      color: "#2f6b57",
      roughness: 0.9,
      flatShading: true,
    });
    const makeCactus = (height: number): THREE.Group => {
      const group = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.17, 0.2, height, 7),
        cactusMaterial,
      );
      trunk.position.y = height / 2;
      trunk.castShadow = true;
      group.add(trunk);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.17, 7, 5), cactusMaterial);
      cap.position.y = height;
      cap.castShadow = true;
      group.add(cap);
      const armCount = rng() > 0.45 ? 2 : 1;
      for (let a = 0; a < armCount; a++) {
        const side = a === 0 ? 1 : -1;
        const armHeight = height * (0.45 + rng() * 0.2);
        const elbow = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.1, 0.42, 6),
          cactusMaterial,
        );
        elbow.rotation.z = Math.PI / 2;
        elbow.position.set(side * 0.26, armHeight, 0);
        elbow.castShadow = true;
        group.add(elbow);
        const upper = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.1, height * 0.5, 6),
          cactusMaterial,
        );
        upper.position.set(side * 0.44, armHeight + height * 0.25, 0);
        upper.castShadow = true;
        group.add(upper);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 4), cactusMaterial);
        tip.position.set(side * 0.44, armHeight + height * 0.5, 0);
        group.add(tip);
      }
      group.rotation.y = rng() * Math.PI * 2;
      return group;
    };
    for (let i = 0; i < 6; i++) {
      const spot = place(5.2, 2.6);
      if (!spot) continue;
      const cactus = makeCactus(1.5 + rng() * 0.9);
      cactus.position.set(spot.x, 0, spot.z);
      this.scene.add(cactus);
    }

    // Low desert shrubs.
    const shrubGeometry = new THREE.IcosahedronGeometry(1, 0);
    const shrubMaterials = ["#7d8a52", "#8f9a5c"].map(
      (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }),
    );
    for (let i = 0; i < 10; i++) {
      const spot = place(3.6, 1.5);
      if (!spot) continue;
      const shrub = new THREE.Mesh(
        shrubGeometry,
        shrubMaterials[Math.floor(rng() * shrubMaterials.length)],
      );
      const scale = 0.24 + rng() * 0.3;
      shrub.position.set(spot.x, scale * 0.5, spot.z);
      shrub.scale.set(scale, scale * 0.75, scale * (0.8 + rng() * 0.4));
      shrub.rotation.y = rng() * Math.PI;
      shrub.castShadow = true;
      this.scene.add(shrub);
    }

    // Soft sand mounds for a sculpted feel.
    const moundGeometry = new THREE.IcosahedronGeometry(1, 1);
    const moundMaterial = new THREE.MeshStandardMaterial({
      color: "#dfc089",
      roughness: 1,
      flatShading: true,
    });
    for (let i = 0; i < 5; i++) {
      const spot = place(4.2, 3.2);
      if (!spot) continue;
      const mound = new THREE.Mesh(moundGeometry, moundMaterial);
      const scale = 1.5 + rng() * 1.5;
      mound.position.set(spot.x, 0.02, spot.z);
      mound.scale.set(scale, 0.22 + rng() * 0.16, scale * (0.7 + rng() * 0.5));
      mound.rotation.y = rng() * Math.PI;
      mound.receiveShadow = true;
      this.scene.add(mound);
    }
  }

  // ------------------------------------------------------------- checkpoints

  private buildCheckpoints(): void {
    const postGeometry = new THREE.BoxGeometry(0.1, 0.55, 0.1);
    const capGeometry = new THREE.BoxGeometry(0.13, 0.06, 0.13);
    const postMaterial = new THREE.MeshStandardMaterial({ color: CREAM, roughness: 0.8 });
    const capMaterial = new THREE.MeshStandardMaterial({ color: TERRACOTTA, roughness: 0.8 });
    const posts = new THREE.InstancedMesh(postGeometry, postMaterial, GATES.length * 2);
    const caps = new THREE.InstancedMesh(capGeometry, capMaterial, GATES.length * 2);
    const dummy = new THREE.Object3D();
    let index = 0;
    for (const gate of GATES) {
      const pose = poseAt(gate.s);
      const nx = -Math.sin(pose.heading);
      const nz = Math.cos(pose.heading);
      for (const side of [-1, 1]) {
        const x = pose.x + nx * side * 2.75;
        const z = pose.z + nz * side * 2.75;
        dummy.position.set(x, 0.275, z);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        posts.setMatrixAt(index, dummy.matrix);
        dummy.position.set(x, 0.58, z);
        dummy.updateMatrix();
        caps.setMatrixAt(index, dummy.matrix);
        index++;
      }
    }
    posts.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    posts.castShadow = true;
    this.scene.add(posts);
    this.scene.add(caps);

    const stripeGeometry = new THREE.PlaneGeometry(0.5, 4);
    stripeGeometry.rotateX(-Math.PI / 2);
    const stripe = new THREE.Mesh(
      stripeGeometry,
      new THREE.MeshBasicMaterial({
        color: "#2fb3a5",
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    );
    stripe.position.y = ROAD_SURFACE_Y + 0.02;
    stripe.renderOrder = 2;
    this.nextGroup.add(stripe);

    const diamondGeometry = new THREE.OctahedronGeometry(0.27, 0);
    const diamondMaterial = new THREE.MeshStandardMaterial({
      color: "#2fb3a5",
      emissive: "#1f8a80",
      emissiveIntensity: 0.6,
      roughness: 0.4,
      flatShading: true,
    });
    for (const side of [-1, 1]) {
      const diamond = new THREE.Mesh(diamondGeometry, diamondMaterial);
      diamond.position.set(side * 2.75, 1.05, 0);
      diamond.castShadow = true;
      this.diamonds.push(diamond);
      this.nextGroup.add(diamond);
    }
    this.scene.add(this.nextGroup);
  }

  // ------------------------------------------------------------------- API

  /** Move the highlight to the checkpoint the player must reach next (0-based). */
  setNextCheckpoint(index: number): void {
    if (index === this.nextGateIndex) return;
    this.nextGateIndex = index;
    const gate = GATES[index];
    const pose = poseAt(gate.s);
    this.nextGroup.position.set(pose.x, 0, pose.z);
    this.nextGroup.rotation.y = -pose.heading;
  }

  showCrashMarker(x: number, z: number): void {
    this.crashRing.position.set(x, ROAD_SURFACE_Y + 0.02, z);
    this.crashRing.visible = true;
    this.crashBeacon.position.set(x, ROAD_SURFACE_Y + 0.87, z);
    this.crashBeacon.visible = true;
  }

  hideCrashMarker(): void {
    this.crashRing.visible = false;
    this.crashBeacon.visible = false;
  }

  /**
   * @param alpha accumulator / SIM_STEP, used to interpolate between the two
   *              most recent simulation poses for smooth rendering.
   */
  updateVisuals(
    snapshot: SimSnapshot,
    alpha: number,
    dt: number,
    movedDistance: number,
    reducedMotion: boolean,
  ): void {
    let x = snapshot.x;
    let z = snapshot.z;
    let heading = snapshot.heading;
    if (snapshot.state === "racing") {
      const t = Math.min(Math.max(alpha, 0), 1);
      x = snapshot.prevX + (snapshot.x - snapshot.prevX) * t;
      z = snapshot.prevZ + (snapshot.z - snapshot.prevZ) * t;
      heading = snapshot.prevHeading + (snapshot.heading - snapshot.prevHeading) * t;
    }
    this.car.update({ ...snapshot, x, z, heading }, dt, movedDistance, reducedMotion);
    this.effects.update(dt);
    if (snapshot.state === "racing" && snapshot.steering) {
      this.effects.emitSteering(x, z, heading, dt, reducedMotion);
    }

    this.time += dt;
    for (const [i, diamond] of this.diamonds.entries()) {
      if (reducedMotion) {
        diamond.position.y = 1.05;
        diamond.rotation.y = 0;
      } else {
        diamond.position.y = 1.05 + Math.sin(this.time * 2.1 + i * Math.PI) * 0.06;
        diamond.rotation.y = this.time * 1.4;
      }
    }
    if (this.crashRing.visible) {
      const pulse = reducedMotion ? 0.85 : 0.62 + 0.22 * Math.sin(this.time * 2.6);
      this.crashRingMaterial.opacity = pulse;
      this.crashBeaconMaterial.opacity = reducedMotion ? 0.45 : 0.3 + 0.18 * Math.sin(this.time * 2.6);
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** Resize the drawing buffer and refit the camera to the new viewport. */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitCamera();
  }

  /**
   * Fit the base's bounding box exactly into the view for any aspect ratio.
   * Portrait screens rotate the framing so the long axis of the circuit runs
   * vertically, which fills the tall viewport instead of shrinking the scene.
   */
  private fitCamera(): void {
    const aspect = this.camera.aspect;
    const portrait = aspect < 0.9;
    const fovY = THREE.MathUtils.degToRad(this.camera.fov);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
    const tanY = Math.tan(fovY / 2);
    const tanX = Math.tan(fovX / 2);

    const dir = portrait
      ? new THREE.Vector3(0.6, 0.74, 0.22).normalize()
      : new THREE.Vector3(0.17, 0.67, 0.72).normalize();
    const target = new THREE.Vector3(0, 0.3, 0);

    const forward = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    // Nudge the framing so the circuit sits above the bottom HUD on phones.
    if (portrait) target.addScaledVector(up, -1.8);

    const insetX = portrait ? 2.0 : 0.9;
    const insetZ = portrait ? 1.8 : 1.4;
    const corners: THREE.Vector3[] = [];
    for (const cx of [-BASE_HALF_X + insetX, BASE_HALF_X - insetX]) {
      for (const cy of [-BASE_DEPTH - 0.2, 3.0]) {
        for (const cz of [-BASE_HALF_Z + insetZ, BASE_HALF_Z - insetZ]) {
          corners.push(new THREE.Vector3(cx, cy, cz));
        }
      }
    }

    let distance = 12;
    for (const corner of corners) {
      const w = corner.clone().sub(target);
      const depthAhead = -w.dot(dir);
      distance = Math.max(
        distance,
        Math.abs(w.dot(right)) / tanX - depthAhead,
        Math.abs(w.dot(up)) / tanY - depthAhead,
      );
    }
    distance = distance * 1.01 + 0.5;

    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(target).addScaledVector(dir, distance);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
  }
}
