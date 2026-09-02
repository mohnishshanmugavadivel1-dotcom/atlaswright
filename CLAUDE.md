# ATLASWRIGHT

Browser-based cartography survey game. "Naked Sweep" prototype — reward-free survey loop.

## Project structure

- `index.html` — game page, HUD, chart overlay, CSS
- `game.js` — orchestrator, state, game loop
- `noise.js` — seeded simplex noise + fbm
- `world.js` — terrain, fog, landmarks, beacons, bearings, resection
- `renderer.js` — canvas rendering, minimap, HUD, crosshair
- `chart.js` — chart overlay, drawing, fix stamping, publish
- `input.js` — pointer lock, WASD/mouse, keyboard bindings

## Tech

Zero dependencies. 6 ES modules. Runs from any static file server.

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
