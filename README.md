# Hill Racer 🏔️🚗

A physics-based hill-climbing driving game built with vanilla JavaScript and HTML5 Canvas — no frameworks, no build step. Works on desktop (keyboard) and mobile (touch controls).

## Play
Open `index.html` in any modern browser, or deploy via GitHub Pages (see below).

## Controls

**Desktop**
- `→` / `D` — Gas
- `←` / `A` — Brake / reverse
- `↑` / `W` — Lean back (mid-air rotation)
- `↓` / `S` — Lean forward (mid-air rotation)
- `P` — Pause

**Mobile**
- On-screen GAS / BRAKE pedals
- On-screen ↺ / ↻ lean buttons for mid-air control

## Features
- Procedurally generated, infinite terrain (layered noise, progressive difficulty)
- Verlet-style two-wheel suspension physics with spring/damper correction
- Fuel system — manage your throttle or you'll run dry
- Coin collection with particle effects
- Flip detection & "FLIP! / DOUBLE FLIP!" toast
- Crash detection (steep landings, falling off track)
- Best-distance persistence via `localStorage`
- Pause / resume / game-over flow
- Fully responsive HUD, safe-area aware for notched phones
- `prefers-reduced-motion`–friendly, no external dependencies

## Deploying to GitHub Pages
1. Push this folder to a GitHub repository.
2. In the repo settings, go to **Pages** → set source to the `main` branch, root folder.
3. Your game will be live at `https://<username>.github.io/<repo-name>/`.

## File structure
```
hill-climb-game/
├── index.html   # Markup, HUD, overlays
├── style.css    # All styling (responsive + touch controls)
└── game.js      # Terrain gen, physics, rendering, input, game loop
```

## Tech notes
- Terrain height is computed from 3 layered value-noise octaves, with amplitude/frequency increasing with distance for difficulty ramping.
- The vehicle is simulated as a chassis point with two wheel contact points; each frame, ground penetration is corrected via a spring-like position/angle correction rather than a full rigid-body solver, which keeps it fast and stable at any frame rate (fixed-timestep loop with accumulator).
- All rendering is canvas-based; the game targets 60fps fixed-step physics decoupled from render rate.

Built to pair with a matching portfolio site design system (Syne + Inter, indigo/amber/navy palette).
