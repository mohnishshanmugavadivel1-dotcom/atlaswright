# ATLASWRIGHT

Browser-based cartography survey game. Reward-free survey loop: explore, take bearings, compute position via resection, draw a chart.

## Project structure

- `index.html` — game page, HUD, chart overlay, CSS (design tokens via CSS custom properties)
- `noise.js` — seeded simplex noise + fbm (pure math, 42 lines)
- `world.js` — terrain, fog, landmarks, beacons, bearings, resection (pure logic, zero DOM, 190 lines)
- `audio.js` — Web Audio ambient system, sound cues, mute toggle (66 lines)
- `chart.js` — chart overlay drawing, ink strokes, undo, export/import (196 lines)
- `render.js` — canvas rendering: terrain, landmarks, beacons, crosshair, player, minimap (168 lines)
- `game.js` — state, input, persistence, game loop (355 lines)
- `tests/contract.test.js` — 44 behavior tests (noise, terrain, targets, resection, fog, beacon cap, shoreline spawn, reset, restore, export/import, seed persistence)

## Architecture

Six focused modules. `noise.js` and `world.js` are pure logic (zero DOM). `audio.js`, `chart.js`, `render.js` own their DOM refs and state. `game.js` is the orchestrator: state, input, persistence, game loop. Data flows: game.js owns game state, passes it as parameters to render.js and chart.js. world.js is fully testable without mocks.

Key constants: `WORLD=1024` (map size), `PPM=2.5` (pixels per meter), `FR=320` (field radius), `MB=24` (max beacons), `ALG=0.0698` (alignment threshold in radians ~4°).

## Tech

Zero dependencies. ES modules. Runs from any static file server (`python3 -m http.server`). Deployable to Vercel (`vercel.json` included).

## Deployment

`vercel.json` configured for static hosting. Deploy with `npx vercel` or connect repo to Vercel dashboard.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
