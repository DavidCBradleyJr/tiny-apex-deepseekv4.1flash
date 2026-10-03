/**
 * Tiny Apex — browser verification. Drives the installed system Chrome through
 * project-local playwright-core. This is a development/verification tool, not
 * part of the game bundle.
 *
 * Usage:
 *   npm run dev            # or: npm run preview
 *   npm run verify:browser
 *   TINY_APEX_URL=http://127.0.0.1:4173/ npm run verify:browser
 */

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "verify-out");
mkdirSync(outDir, { recursive: true });
const baseUrl = process.env.TINY_APEX_URL ?? "http://127.0.0.1:5173/";

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

// A tiny test-only autopilot: steers toward the centreline tangent for the
// current position with a small deadband, dispatching real Space events so the
// whole input path is exercised. Position-based, so it self-corrects even when
// frames are slow (software rendering in CI).
const AUTOPILOT = `(() => {
  const TAU = Math.PI * 2;
  let last = "";
  const tick = () => {
    const s = window.__tinyApex.snapshot();
    const h = ((s.heading % TAU) + TAU) % TAU;
    // Exact rule proven by the unit-test autopilot.
    const steer =
      (h > 0.05 && h < Math.PI - 0.05) ||
      (h > Math.PI + 0.05 && h < TAU - 0.05) ||
      (s.x > 6.2 && s.z < -6.5) ||
      (s.x < -6.2 && s.z > 6.5);
    const ev = steer ? "keydown" : "keyup";
    if (ev !== last) {
      window.dispatchEvent(new KeyboardEvent(ev, { code: "Space" }));
      last = ev;
    }
  };
  window.__autopilot = setInterval(tick, 16);
  return true;
})()`;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader", "--disable-dev-shm-usage"],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  const freshRacing = async () => {
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.__tinyApex), null, { timeout: 15000 });
    await page.waitForTimeout(350);
    await page.click("#start-button");
    await page.waitForTimeout(80);
  };

  // ---------------------------------------------------------------- desktop
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForFunction(() => Boolean(window.__tinyApex), null, { timeout: 15000 });
  await page.waitForTimeout(700);

  const renderer = await page.evaluate(() => window.__tinyApex.renderer());
  check(
    "desktop: WebGL2 context created",
    renderer.isWebGL2 === true,
    JSON.stringify(renderer),
  );
  check(
    "desktop: drawing buffer matches 1440x900 viewport",
    Math.abs(renderer.drawingBufferWidth - 1440) <= 2 &&
      Math.abs(renderer.drawingBufferHeight - 900) <= 2,
    `${renderer.drawingBufferWidth}x${renderer.drawingBufferHeight}`,
  );

  const ready = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: initial state is ready at the spawn",
    ready.state === "ready" && ready.x === -7 && ready.z === -8 && ready.heading === 0,
    JSON.stringify({ state: ready.state, x: ready.x, z: ready.z }),
  );

  const layout = await page.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const chipRect = (id) => document.getElementById(id).parentElement.getBoundingClientRect();
    const inBounds = (r) => r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    return {
      panelVisible: !document.getElementById("panel-ready").hidden && rect("panel-ready").height > 80,
      startVisible: rect("start-button").width > 100,
      stateText: document.getElementById("state-value").textContent,
      hintVisible: !document.getElementById("hint").hidden,
      chipInBounds: inBounds(rect("state-chip")) && inBounds(chipRect("points-value")) && inBounds(chipRect("laps-value")),
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      frames: window.__tinyApex.frames(),
    };
  });
  check(
    "desktop: ready panel, Start button and state chip visible",
    layout.panelVisible && layout.startVisible && layout.stateText === "Ready",
    JSON.stringify(layout),
  );
  check("desktop: HUD elements inside the viewport", layout.chipInBounds);
  check("desktop: no horizontal scrolling", layout.scrollWidth <= layout.innerWidth);
  await page.screenshot({ path: join(outDir, "desktop-1-ready.png") });

  // Start + trusted Space hold/release.
  await page.click("#start-button");
  await page.waitForTimeout(120);
  const started = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: Start begins the run from the spawn",
    started.state === "racing" && started.points === 0 && started.laps === 0,
  );
  await page.screenshot({ path: join(outDir, "desktop-2-racing.png") });

  await page.keyboard.down("Space");
  await page.waitForTimeout(380);
  const holding = await page.evaluate(() => window.__tinyApex.snapshot());
  await page.keyboard.up("Space");
  await page.waitForTimeout(80);
  const released = await page.evaluate(() => window.__tinyApex.snapshot());
  await page.waitForTimeout(250);
  const coasting = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: holding Space turns clockwise",
    holding.steering === true && holding.heading > 0.25,
    `heading=${holding.heading.toFixed(3)}`,
  );
  check(
    "desktop: releasing Space stops turning",
    released.steering === false &&
      coasting.steering === false &&
      Math.abs(coasting.heading - released.heading) < 0.02,
    `heading ${released.heading.toFixed(3)} -> ${coasting.heading.toFixed(3)}`,
  );
  check("desktop: Space did not scroll the page", (await page.evaluate(() => window.scrollY)) === 0);

  // Surviving early does not score; never steering crashes at the first corner.
  await freshRacing();
  await page.waitForTimeout(900);
  const surviving = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: merely surviving does not score",
    surviving.state === "racing" && surviving.points === 0,
    `points=${surviving.points}`,
  );
  await page.waitForTimeout(2600);
  const crashedStraight = await page.evaluate(() => window.__tinyApex.snapshot());
  const crashPanel = await page.evaluate(() => ({
    visible: !document.getElementById("panel-crashed").hidden,
    result: document.getElementById("crash-result").textContent,
    state: document.getElementById("state-value").textContent,
  }));
  check(
    "desktop: never steering crashes at the first corner",
    crashedStraight.state === "crashed" &&
      crashedStraight.elapsed > 2.2 &&
      crashedStraight.elapsed < 2.6 &&
      crashedStraight.x > 11.5 &&
      crashedStraight.x < 12.2,
    `elapsed=${crashedStraight.elapsed.toFixed(2)}s x=${crashedStraight.x.toFixed(2)} points=${crashedStraight.points}`,
  );
  check(
    "desktop: crash panel shows the run result",
    crashPanel.visible && crashPanel.result.includes("Points 1") && crashPanel.result.includes("Laps 0") && crashPanel.state === "Crashed",
    JSON.stringify(crashPanel),
  );
  await page.screenshot({ path: join(outDir, "desktop-3-crashed.png") });

  // Restart resets; holding forever crashes quickly; restart works twice.
  await page.click("#restart-button");
  await page.waitForTimeout(30);
  const restarted = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: Restart resets car, points and laps",
    restarted.state === "racing" &&
      Math.hypot(restarted.x + 7, restarted.z + 8) < 1.5 &&
      restarted.points === 0 &&
      restarted.laps === 0 &&
      restarted.nextCheckpoint === 1 &&
      restarted.elapsed < 0.25,
    `distance-from-spawn=${Math.hypot(restarted.x + 7, restarted.z + 8).toFixed(2)} elapsed=${restarted.elapsed.toFixed(2)}`,
  );
  await page.keyboard.down("Space");
  await page.waitForTimeout(1300);
  await page.keyboard.up("Space");
  const crashedHold = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: holding steering forever crashes quickly",
    crashedHold.state === "crashed" && crashedHold.elapsed < 1.2 && crashedHold.x > -3.5 && crashedHold.x < 0,
    `elapsed=${crashedHold.elapsed.toFixed(2)}s x=${crashedHold.x.toFixed(2)}`,
  );
  await page.click("#restart-button");
  await page.waitForTimeout(80);
  check(
    "desktop: second restart works",
    (await page.evaluate(() => window.__tinyApex.snapshot())).state === "racing",
  );

  // Full lap with an in-page autopilot driving the real Space handlers. Run at
  // a lighter viewport so software rendering keeps up and the input cadence is
  // close to a real machine; the layout checks above already covered 1440x900.
  await page.setViewportSize({ width: 900, height: 600 });
  await page.waitForTimeout(300);
  await page.evaluate(AUTOPILOT);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(outDir, "desktop-4-checkpoint.png") });
  const lapDeadline = Date.now() + 40000;
  let lapSnapshot = null;
  while (Date.now() < lapDeadline) {
    lapSnapshot = await page.evaluate(() => window.__tinyApex.snapshot());
    if (lapSnapshot.laps >= 1 || lapSnapshot.state === "crashed") break;
    await page.waitForTimeout(500);
  }
  await page.evaluate(() => {
    clearInterval(window.__autopilot);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  });
  check(
    "desktop: a correctly timed sequence completes a lap",
    lapSnapshot && lapSnapshot.state === "racing" && lapSnapshot.laps >= 1 && lapSnapshot.points === lapSnapshot.laps * 8,
    lapSnapshot ? `laps=${lapSnapshot.laps} points=${lapSnapshot.points} state=${lapSnapshot.state}` : "no snapshot",
  );
  check(
    "desktop: HUD lap counter updated",
    (await page.evaluate(() => document.getElementById("laps-value").textContent)) === String(lapSnapshot?.laps ?? -1),
  );
  // Pause on focus loss, no fast-forward, explicit resume. Pause right after
  // the autopilot stops so the car does not drive on and crash.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(120);
  const paused = await page.evaluate(() => window.__tinyApex.snapshot());
  const pausedPanel = await page.evaluate(() => ({
    visible: !document.getElementById("panel-paused").hidden,
    state: document.getElementById("state-value").textContent,
    focused: document.activeElement?.id,
  }));
  check(
    "desktop: losing focus pauses the race",
    paused.state === "paused" && pausedPanel.visible && pausedPanel.state === "Paused",
    JSON.stringify(pausedPanel),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const pausedAfterResize = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: resizing while paused keeps the run",
    pausedAfterResize.state === "paused" && pausedAfterResize.laps === paused.laps,
    `state=${pausedAfterResize.state} laps=${pausedAfterResize.laps}`,
  );
  const pausedX = paused.x;
  const pausedElapsed = paused.elapsed;
  await page.waitForTimeout(600);
  const stillPaused = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: paused car does not move",
    stillPaused.x === pausedX && stillPaused.elapsed === pausedElapsed,
  );
  await page.click("#resume-button");
  await page.waitForTimeout(120);
  const resumed = await page.evaluate(() => window.__tinyApex.snapshot());
  const resumeJump = Math.hypot(resumed.x - pausedX, resumed.z - paused.z);
  check(
    "desktop: Resume continues without fast-forward",
    resumed.state === "racing" &&
      resumed.elapsed - pausedElapsed < 0.5 &&
      resumeJump <= (resumed.elapsed - pausedElapsed) * 8 + 0.35,
    `elapsed +${(resumed.elapsed - pausedElapsed).toFixed(2)}s, moved ${resumeJump.toFixed(2)}u (max ${((resumed.elapsed - pausedElapsed) * 8 + 0.35).toFixed(2)}u)`,
  );
  await page.screenshot({ path: join(outDir, "desktop-5-resumed.png") });

  // Pointer steering: hold, drag off the button, release outside.
  await freshRacing();
  const buttonBox = await page.locator("#steer-button").boundingBox();
  check(
    "desktop: steering target is at least 64x64 CSS px",
    buttonBox && buttonBox.width >= 64 && buttonBox.height >= 64,
    buttonBox ? `${Math.round(buttonBox.width)}x${Math.round(buttonBox.height)}` : "missing",
  );
  await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(60);
  const pointerDown = await page.evaluate(() => ({
    input: window.__tinyApex.inputSteering(),
    snapshot: window.__tinyApex.snapshot(),
  }));
  await page.mouse.move(120, 120, { steps: 6 });
  await page.waitForTimeout(60);
  const draggedOff = await page.evaluate(() => ({
    input: window.__tinyApex.inputSteering(),
    snapshot: window.__tinyApex.snapshot(),
  }));
  await page.mouse.up();
  await page.waitForTimeout(60);
  const pointerUp = await page.evaluate(() => ({
    input: window.__tinyApex.inputSteering(),
    snapshot: window.__tinyApex.snapshot(),
  }));
  check(
    "desktop: pointer press steers, dragging off keeps steering, release outside stops it",
    pointerDown.input === true &&
      pointerDown.snapshot.steering === true &&
      draggedOff.input === true &&
      pointerUp.input === false &&
      pointerUp.snapshot.steering === false,
    JSON.stringify({
      down: pointerDown.input,
      dragged: draggedOff.input,
      up: pointerUp.input,
      state: pointerUp.snapshot.state,
    }),
  );

  // Keyboard and pointer held together must stay consistent.
  await freshRacing();
  await page.keyboard.down("Space");
  await page.waitForTimeout(70);
  const keyOnly = await page.evaluate(() => window.__tinyApex.inputSteering());
  const buttonBox2 = await page.locator("#steer-button").boundingBox();
  await page.mouse.move(buttonBox2.x + buttonBox2.width / 2, buttonBox2.y + buttonBox2.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(70);
  const bothHeld = await page.evaluate(() => window.__tinyApex.inputSteering());
  await page.mouse.up();
  await page.waitForTimeout(70);
  const pointerReleased = await page.evaluate(() => window.__tinyApex.inputSteering());
  await page.keyboard.up("Space");
  await page.waitForTimeout(70);
  const allReleased = await page.evaluate(() => window.__tinyApex.inputSteering());
  check(
    "desktop: keyboard and pointer combine consistently",
    keyOnly === true && bothHeld === true && pointerReleased === true && allReleased === false,
    JSON.stringify({ keyOnly, bothHeld, pointerReleased, allReleased }),
  );

  // Synthetic pointercancel and lostpointercapture release steering.
  await freshRacing();
  const cancelRelease = await page.evaluate(async () => {
    const button = document.getElementById("steer-button");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const down = () =>
      button.dispatchEvent(
        new PointerEvent("pointerdown", { pointerId: 77, bubbles: true, cancelable: true }),
      );
    down();
    await sleep(60);
    const afterDown = window.__tinyApex.inputSteering();
    button.dispatchEvent(
      new PointerEvent("pointercancel", { pointerId: 77, bubbles: true, cancelable: true }),
    );
    await sleep(60);
    const afterCancel = window.__tinyApex.inputSteering();
    down();
    await sleep(60);
    button.dispatchEvent(new PointerEvent("lostpointercapture", { pointerId: 77, bubbles: true }));
    await sleep(60);
    const afterLost = window.__tinyApex.inputSteering();
    return { afterDown, afterCancel, afterLost };
  });  check(
    "desktop: pointercancel and lostpointercapture release steering",
    cancelRelease.afterDown === true &&
      cancelRelease.afterCancel === false &&
      cancelRelease.afterLost === false,
    JSON.stringify(cancelRelease),
  );

  // Resize keeps world geometry and progress; drawing buffer follows.
  await freshRacing();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(120);
  const beforeResize = await page.evaluate(() => window.__tinyApex.snapshot());
  check("desktop: blur pauses before the resize check", beforeResize.state === "paused");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const smallBuffer = await page.evaluate(() => window.__tinyApex.renderer());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  const largeBuffer = await page.evaluate(() => window.__tinyApex.renderer());
  const afterResize = await page.evaluate(() => window.__tinyApex.snapshot());
  check(
    "desktop: resizing updates the drawing buffer",
    smallBuffer.drawingBufferWidth === 390 && smallBuffer.drawingBufferHeight === 844 && largeBuffer.drawingBufferWidth === 1440,
    `${smallBuffer.drawingBufferWidth}x${smallBuffer.drawingBufferHeight} -> ${largeBuffer.drawingBufferWidth}x${largeBuffer.drawingBufferHeight}`,
  );
  check(
    "desktop: resizing preserves the run",
    afterResize.points === beforeResize.points && afterResize.laps === beforeResize.laps && afterResize.state === "paused",
  );

  // Measured frame rate while racing (software renderer in headless Chrome).
  await page.click("#resume-button");
  await page.evaluate(AUTOPILOT);
  await page.waitForTimeout(400);
  const fpsSample = await page.evaluate(async () => {
    const startFrames = window.__tinyApex.frames();
    const startTime = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const frames = window.__tinyApex.frames() - startFrames;
    const seconds = (performance.now() - startTime) / 1000;
    return { fps: frames / seconds, frames, seconds };
  });
  await page.evaluate(() => {
    clearInterval(window.__autopilot);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  });
  console.log(`INFO  measured render rate in headless software rendering: ${fpsSample.fps.toFixed(1)} fps (${fpsSample.frames} frames / ${fpsSample.seconds.toFixed(2)}s)`);

  // Resource origins: the game must not request anything external.
  const origins = await page.evaluate(() =>
    Array.from(new Set(performance.getEntriesByType("resource").map((entry) => new URL(entry.name).origin))),
  );
  const expectedOrigin = new URL(baseUrl).origin;
  check(
    "desktop: no external network requests",
    origins.every((origin) => origin === expectedOrigin),
    origins.join(", "),
  );

  check("desktop: no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  check("desktop: no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

  // ----------------------------------------------------------------- mobile
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  const mobileErrors = [];
  mobilePage.on("pageerror", (error) => mobileErrors.push(String(error)));
  await mobilePage.goto(baseUrl, { waitUntil: "load" });
  await mobilePage.waitForFunction(() => Boolean(window.__tinyApex), null, { timeout: 15000 });
  await mobilePage.waitForTimeout(700);

  const mobileLayout = await mobilePage.evaluate(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect();
    const chipRect = (id) => document.getElementById(id).parentElement.getBoundingClientRect();
    const inBounds = (r) =>
      r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      chipInBounds: inBounds(rect("state-chip")) && inBounds(chipRect("points-value")) && inBounds(chipRect("laps-value")),
      startInBounds: inBounds(rect("start-button")),
      panelInBounds: inBounds(rect("panel-ready")),
      buffer: window.__tinyApex.renderer(),
    };
  });
  check(
    "mobile 390x844: no horizontal scrolling",
    mobileLayout.scrollWidth <= mobileLayout.innerWidth,
    `scrollWidth=${mobileLayout.scrollWidth}`,
  );
  check(
    "mobile 390x844: HUD chips, panel and Start button inside the viewport",
    mobileLayout.chipInBounds && mobileLayout.startInBounds && mobileLayout.panelInBounds,
  );
  check(
    "mobile 390x844: drawing buffer follows the viewport and DPR cap",
    mobileLayout.buffer.drawingBufferWidth === 780 && mobileLayout.buffer.drawingBufferHeight === 1688,
    JSON.stringify(mobileLayout.buffer),
  );
  await mobilePage.screenshot({ path: join(outDir, "mobile-1-ready.png") });

  await mobilePage.tap("#start-button");
  await mobilePage.waitForTimeout(300);
  const mobileButton = await mobilePage.locator("#steer-button").boundingBox();
  check(
    "mobile 390x844: steering target is at least 64x64 CSS px",
    mobileButton && mobileButton.width >= 64 && mobileButton.height >= 64,
    mobileButton ? `${Math.round(mobileButton.width)}x${Math.round(mobileButton.height)}` : "missing",
  );
  const mobileSteer = await mobilePage.evaluate(() => {
    const r = document.getElementById("steer-button").getBoundingClientRect();
    return {
      inBounds:
        r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      hintVisible: !document.getElementById("hint").hidden,
      hintInBounds: (() => {
        const h = document.getElementById("hint").getBoundingClientRect();
        return h.left >= -1 && h.right <= window.innerWidth + 1;
      })(),
    };
  });
  check(
    "mobile 390x844: steering control and hint fit the viewport",
    mobileSteer.inBounds && mobileSteer.hintVisible && mobileSteer.hintInBounds,
    JSON.stringify(mobileSteer),
  );
  await mobilePage.screenshot({ path: join(outDir, "mobile-2-racing.png") });
  check("mobile 390x844: no uncaught page errors", mobileErrors.length === 0, mobileErrors.slice(0, 2).join(" | "));

  // --------------------------------------------------------- reduced motion
  const reduced = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(baseUrl, { waitUntil: "load" });
  await reducedPage.waitForFunction(() => Boolean(window.__tinyApex), null, { timeout: 15000 });
  await reducedPage.click("#start-button");
  await reducedPage.waitForTimeout(500);
  const reducedState = await reducedPage.evaluate(() => ({
    reduced: window.__tinyApex.reducedMotion(),
    state: window.__tinyApex.snapshot().state,
  }));
  check(
    "reduced motion: preference detected and game still runs",
    reducedState.reduced === true && reducedState.state === "racing",
    JSON.stringify(reducedState),
  );
} finally {
  await browser.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.log("Failed checks:");
  for (const entry of failed) console.log(`  - ${entry.name}${entry.detail ? ` [${entry.detail}]` : ""}`);
  process.exit(1);
}
