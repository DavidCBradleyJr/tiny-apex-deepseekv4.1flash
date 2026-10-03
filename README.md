# Tiny Apex

A finished, one-button arcade racing toy: hold to turn clockwise, release to drive
straight, sweep eight checkpoints in order around a miniature desert circuit.
Everything you see is authored in code with Three.js primitives, extrusions and
canvas textures — no downloaded models, images, fonts or runtime network requests.

The original task brief this project was built from is kept in [`PROMPT.md`](PROMPT.md).

## Commands

| Command                | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm install`          | Reproducible install from `package-lock.json` (`npm ci` also works) |
| `npm run dev`          | Local Vite dev server at http://127.0.0.1:5173                      |
| `npm run typecheck`    | `tsc` in no-emit strict mode                                        |
| `npm run build`        | Typecheck, then production Vite build into `dist/`                  |
| `npm run preview`      | Serve the built `dist/` at http://127.0.0.1:4173                    |
| `npm test`             | Compile and run the simulation tests with `node --test`             |
| `npm run verify:browser` | Playwright gameplay/layout verification (39 checks + screenshots) |

## Controls

- **Hold Space** or the on-screen **TURN** button — turn clockwise (viewed from above).
- **Release** — drive straight.
- **Enter** — start / restart / resume from the visible panel button.
- **P / Esc** — pause. Losing window focus or hiding the page pauses too; resuming is
  always explicit.
- Releasing a touch after dragging off the TURN button releases steering; so do
  `pointerup`, `pointercancel` and lost pointer capture.

## Rules (fixed contract)

- Stadium circuit: two 14-unit straights joined by radius-8 semicircles, road width 4,
  all centred on the same path used for collision and checkpoints.
- Constant speed 8 units/s, steering 1 rad/s clockwise, fixed 1/120 s simulation step.
- Collision footprint: circle radius 0.65 centred on the car; leaving the road crashes.
- Eight checkpoints evenly spaced by distance, the eighth at the start/finish line.
  Only the next checkpoint in order, crossed in the forward direction while on the
  road, scores. A lap is 8 checkpoints. No randomness anywhere in the rules.

## Layout of the code

```
src/sim/track.ts     pure track geometry, checkpoints and crossing tests
src/sim/game.ts      TinyApexSim: states, fixed-step update, scoring, events
src/render/world.ts  scene, circuit, landmarks, scenery, camera fit
src/render/car.ts    the car model and its cosmetic motion
src/render/effects.ts pooled skid marks and dust
src/main.ts          DOM glue, input, fixed-step loop, UI states
test/                node:test unit tests for geometry, collision and scoring
scripts/verify-browser.mjs  Playwright end-to-end verification
```

Simulation state is separate from rendering: the renderer interpolates between the
last two simulation poses and never influences the rules. One animation loop drives
a fixed-step accumulator (max 40 catch-up steps, backlog dropped rather than
fast-forwarded, clock reset after pause/resume).

## Versions used (measured)

| Tool            | Version    |
| --------------- | ---------- |
| Node.js         | 26.8.2     |
| npm             | 11.19.1    |
| three           | 0.186.1    |
| @types/three    | 0.186.0    |
| vite            | 8.3.2      |
| typescript      | 5.9.3      |
| @types/node     | 26.6.4     |
| playwright-core | 1.63.0     |
| Chrome (headless, verification) | 154.0.8037.57 |
| test runner     | `node --test` (built into Node 26.8.2) |

Install: `npm install` (26 packages, official npm registry). `package-lock.json` is
committed for reproducible installs.

Compatibility notes / repairs made during setup:

- Vite 8.3.2 requires Node `^20.19.0 || >=22.12.0`; Node 26.8.2 satisfies it.
- TypeScript is pinned to 5.9.3 (latest stable line) rather than the 7.x preview.
- `vite.config.mts` uses the `.mts` extension because `package.json` is CommonJS for
  the compiled test output.
- three 0.186 removed `PCFSoftShadowMap`; the renderer uses `PCFShadowMap`.
- The built-in browser tool was not connected in this session, so verification uses a
  project-local `playwright-core` driving the installed Chrome headless with
  `--enable-unsafe-swiftshader` (software WebGL). No browser download, no OS packages.

## Verification (actually run)

- `npm run typecheck` — clean.
- `npm test` — 21/21 simulation tests pass: track dimensions and closed centreline,
  distance metric on both road edges, gate placement and forward-crossing rules,
  corridor legality, never-steer and hold-forever crashes, crash freeze, a
  deterministic 3-lap autopilot (24 points, exact event order), finish-line abuse,
  pause/resume, restart reset and determinism.
- `npm run build` — production bundle ≈ 604 kB (≈ 156 kB gzip).
- `npm run verify:browser` — 39/39 checks pass in real Chrome: WebGL2 context,
  ready/spawn state, HUD bounds and no horizontal scrolling at 1440×900 and 390×844
  (DPR 2, drawing buffer 780×1688), Space turn/release with no page scroll, no score
  from merely surviving, crash without steering at 2.36 s / x 11.87 with points 1,
  crash panel result, restart reset, crash from holding steering, a completed lap
  driven by an in-page autopilot (laps 1, points 8), blur pause with focus on Resume,
  no fast-forward on resume, pointer drag-off and release outside the button,
  keyboard+pointer consistency, `pointercancel` / `lostpointercapture`, resize
  between both required viewports preserving the run, reduced-motion handling, no
  external network requests, no console or page errors.
- Screenshots from the runs are in `verify-out/` (desktop and mobile, ready, racing,
  crashed, checkpoint and resumed states).

Frame rate: the only measured number is from headless software rendering
(SwiftShader): ≈15 fps at 1440×900. That is a software-rasteriser figure, not a
hardware performance claim; the game uses pooled effects, few shadow-casting lights
and a capped device pixel ratio (max 2), but no hardware frame rate was measured.

## Known limitations

- No audio (deliberate: the brief excludes it).
- On a 390 px-wide phone the car is about 13 CSS px long, the honest consequence of
  fitting the whole circuit in view while the collision footprint stays at 0.65 units.
- Touch input is verified with mouse/pointer events and synthetic pointer events in
  Chrome; a real touchscreen device was not available to test.
