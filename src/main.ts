/**
 * Tiny Apex — entry point. Wires the pure simulation to the rendered world:
 * input handling, the fixed-timestep loop, HUD/state panels, popups and the
 * renderer-failure fallback.
 */

import { SIM_STEP, TinyApexSim } from "./sim/game";
import { CAR_SPEED } from "./sim/track";
import { World } from "./render/world";

const VERSION = "1.0.0";

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Tiny Apex: #${id} is missing from index.html`);
  return element as T;
}

const canvas = must<HTMLCanvasElement>("game-canvas");
const stateChip = must<HTMLDivElement>("state-chip");
const stateValue = must<HTMLSpanElement>("state-value");
const pointsValue = must<HTMLSpanElement>("points-value");
const lapsValue = must<HTMLSpanElement>("laps-value");
const pauseButton = must<HTMLButtonElement>("pause-button");
const hint = must<HTMLParagraphElement>("hint");
const steerWrap = must<HTMLDivElement>("steer-wrap");
const steerButton = must<HTMLButtonElement>("steer-button");
const panelReady = must<HTMLElement>("panel-ready");
const panelPaused = must<HTMLElement>("panel-paused");
const panelCrashed = must<HTMLElement>("panel-crashed");
const startButton = must<HTMLButtonElement>("start-button");
const resumeButton = must<HTMLButtonElement>("resume-button");
const restartButton = must<HTMLButtonElement>("restart-button");
const crashResult = must<HTMLParagraphElement>("crash-result");
const popups = must<HTMLDivElement>("popups");

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

function showFatal(message: string, detail?: string): void {
  const wrapper = document.createElement("div");
  wrapper.className = "fatal";
  const panel = document.createElement("section");
  panel.className = "panel";
  const title = document.createElement("h2");
  title.textContent = message;
  const body = document.createElement("p");
  body.textContent = detail ?? "WebGL could not be initialised in this browser.";
  const advice = document.createElement("p");
  advice.textContent =
    "Tiny Apex needs a browser with WebGL. Try enabling hardware acceleration or updating the browser.";
  panel.append(title, body, advice);
  wrapper.appendChild(panel);
  document.getElementById("app")?.appendChild(wrapper);
}

function boot(): void {
  let world: World;
  try {
    world = new World(canvas);
  } catch (error) {
    showFatal(
      "Tiny Apex could not start",
      error instanceof Error ? error.message : String(error),
    );
    console.error(error);
    return;
  }

  const sim = new TinyApexSim();

  const input = {
    keySteer: false,
    pointers: new Set<number>(),
    get steering(): boolean {
      return this.keySteer || this.pointers.size > 0;
    },
    clear(): void {
      this.keySteer = false;
      this.pointers.clear();
      steerButton.classList.remove("is-pressed");
    },
  };

  const refreshSteerVisual = (): void => {
    steerButton.classList.toggle("is-pressed", input.steering);
  };

  let accumulator = 0;
  let lastTime = performance.now();
  let frameCount = 0;
  let failed = false;
  let lastUiState = "";

  const resetClock = (): void => {
    accumulator = 0;
    lastTime = performance.now();
  };

  // ------------------------------------------------------------ transitions

  const updateUi = (force = false): void => {
    const snapshot = sim.getSnapshot();
    if (force || snapshot.state !== lastUiState) {
      lastUiState = snapshot.state;
      stateChip.dataset.state = snapshot.state;
      stateValue.textContent = {
        ready: "Ready",
        racing: "Racing",
        paused: "Paused",
        crashed: "Crashed",
      }[snapshot.state];
      panelReady.hidden = snapshot.state !== "ready";
      panelPaused.hidden = snapshot.state !== "paused";
      panelCrashed.hidden = snapshot.state !== "crashed";
      pauseButton.hidden = snapshot.state !== "racing";
      steerWrap.hidden = snapshot.state !== "racing";
      hint.hidden = snapshot.state === "paused" || snapshot.state === "crashed";
      if (snapshot.state === "ready") startButton.focus();
      else if (snapshot.state === "paused") resumeButton.focus();
      else if (snapshot.state === "crashed") {
        crashResult.textContent = `Points ${snapshot.points} · Laps ${snapshot.laps}`;
        restartButton.focus();
      }
    }
    if (pointsValue.textContent !== String(snapshot.points)) {
      pointsValue.textContent = String(snapshot.points);
    }
    if (lapsValue.textContent !== String(snapshot.laps)) {
      lapsValue.textContent = String(snapshot.laps);
    }
  };

  const startRun = (): void => {
    if (sim.getSnapshot().state !== "ready") return;
    sim.start();
    input.clear();
    resetClock();
    world.effects.reset();
    world.hideCrashMarker();
    updateUi(true);
  };

  const restartRun = (): void => {
    if (sim.getSnapshot().state !== "crashed") return;
    sim.restart();
    input.clear();
    resetClock();
    world.effects.reset();
    world.hideCrashMarker();
    updateUi(true);
  };

  const resumeRun = (): void => {
    if (sim.getSnapshot().state !== "paused") return;
    sim.resume();
    input.clear();
    resetClock();
    updateUi(true);
  };

  const pauseRun = (): void => {
    if (sim.getSnapshot().state !== "racing") return;
    sim.pause();
    input.clear();
    updateUi(true);
  };

  // ----------------------------------------------------------------- input

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        input.keySteer = true;
        refreshSteerVisual();
        return;
      }
      if (event.code === "Enter") {
        const state = sim.getSnapshot().state;
        if (state === "ready") startRun();
        else if (state === "crashed") restartRun();
        else if (state === "paused") resumeRun();
        return;
      }
      if (event.code === "KeyP" || event.code === "Escape") {
        if (sim.getSnapshot().state === "racing") pauseRun();
      }
    },
    { capture: true },
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (event.code === "Space") {
        event.preventDefault();
        input.keySteer = false;
        refreshSteerVisual();
      }
    },
    { capture: true },
  );

  steerButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    input.pointers.add(event.pointerId);
    refreshSteerVisual();
    try {
      steerButton.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events (tests) have no active pointer to capture.
    }
  });

  const releasePointer = (event: PointerEvent): void => {
    if (input.pointers.delete(event.pointerId)) refreshSteerVisual();
  };
  steerButton.addEventListener("pointerup", releasePointer);
  steerButton.addEventListener("pointercancel", releasePointer);
  steerButton.addEventListener("lostpointercapture", releasePointer);
  window.addEventListener("pointerup", releasePointer);
  window.addEventListener("pointercancel", releasePointer);
  steerButton.addEventListener("contextmenu", (event) => event.preventDefault());

  startButton.addEventListener("click", startRun);
  restartButton.addEventListener("click", restartRun);
  resumeButton.addEventListener("click", resumeRun);
  pauseButton.addEventListener("click", pauseRun);

  const clearAndPauseIfRacing = (): void => {
    if (sim.getSnapshot().state === "racing") {
      pauseRun();
    } else {
      input.clear();
    }
  };
  window.addEventListener("blur", clearAndPauseIfRacing);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearAndPauseIfRacing();
  });

  // ------------------------------------------------------------------- HUD

  const popup = (text: string, className = ""): void => {
    const span = document.createElement("span");
    span.className = className ? `popup ${className}` : "popup";
    span.textContent = text;
    popups.appendChild(span);
    const remove = (): void => span.remove();
    span.addEventListener("animationend", remove);
    window.setTimeout(remove, 1600);
  };

  const handleEvents = (): void => {
    for (const event of sim.drainEvents()) {
      if (event.type === "checkpoint") {
        popup(event.checkpoint === 8 ? "+1 · finish" : `+1 · check ${event.checkpoint}`);
      } else if (event.type === "lap") {
        popup(`Lap ${event.laps}`, "lap");
      } else if (event.type === "crash") {
        world.showCrashMarker(event.x, event.z);
        world.effects.burst(event.x, event.z);
      }
    }
  };

  // ------------------------------------------------------------------ loop

  const frame = (now: number): void => {
    if (failed) return;
    requestAnimationFrame(frame);
    frameCount++;

    const dt = Math.min(Math.max((now - lastTime) / 1000, 0), 0.25);
    lastTime = now;

    const before = sim.getSnapshot();
    if (before.state === "racing") {
      accumulator += dt;
      let steps = 0;
      while (accumulator >= SIM_STEP && steps < 40) {
        sim.step(SIM_STEP, { steering: input.steering });
        accumulator -= SIM_STEP;
        steps++;
      }
      // A long interruption must not fast-forward the car.
      if (accumulator >= SIM_STEP) accumulator = 0;
    } else {
      accumulator = 0;
    }

    handleEvents();
    const snapshot = sim.getSnapshot();
    const alpha = Math.min(accumulator / SIM_STEP, 1);
    const movedDistance = snapshot.state === "racing" ? CAR_SPEED * dt : 0;

    try {
      world.setNextCheckpoint(snapshot.nextCheckpoint - 1);
      world.updateVisuals(snapshot, alpha, dt, movedDistance, reducedMotionQuery.matches);
      world.render();
    } catch (error) {
      failed = true;
      showFatal(
        "Tiny Apex hit a rendering error",
        error instanceof Error ? error.message : String(error),
      );
      console.error(error);
      return;
    }

    updateUi();
  };

  const resize = (): void => {
    world.resize(canvas.clientWidth, canvas.clientHeight);
  };
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(resize).observe(canvas);
  }
  window.addEventListener("resize", resize);

  updateUi(true);
  resize();
  requestAnimationFrame(frame);

  // Read-only hook for local verification; it cannot change the game state.
  (window as unknown as { __tinyApex: unknown }).__tinyApex = {
    version: VERSION,
    snapshot: () => sim.getSnapshot(),
    inputSteering: () => input.steering,
    renderer: () => ({
      isWebGL2:
        typeof WebGL2RenderingContext !== "undefined" &&
        world.renderer.getContext() instanceof WebGL2RenderingContext,
      drawingBufferWidth: world.renderer.domElement.width,
      drawingBufferHeight: world.renderer.domElement.height,
      pixelRatio: world.renderer.getPixelRatio(),
    }),
    frames: () => frameCount,
    reducedMotion: () => reducedMotionQuery.matches,
  };
}

boot();
