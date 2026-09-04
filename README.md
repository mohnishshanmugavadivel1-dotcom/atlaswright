# ATLASWRIGHT

Browser-based cartography survey game. Explore a procedural island, take compass bearings on landmarks, compute your position via resection, and draw a hand-drawn survey chart.

## Run

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000` in your browser.

## Controls

| Key | Action |
|-----|--------|
| WASD | Move |
| Mouse | Look around |
| Shift | Run |
| Space | Jump |
| Left Click | Plant beacon |
| E | Record direction to a marker when it is centered in your crosshair |
| F | Plot fix on chart |
| TAB | Open/close chart |
| Z | Undo last stroke |
| ESC | Close chart |

## Project Structure

| File | Purpose |
|------|---------|
| `index.html` | Game page, HUD, onboarding step tracker, chart overlay, CSS |
| `noise.js` | Seeded simplex noise and fractal Brownian motion |
| `world.js` | Terrain, fog-of-war, landmarks, beacons, bearings, resection — pure logic, zero DOM |
| `audio.js` | Web Audio: ambient loop, footstep and record sounds, mute toggle |
| `chart.js` | Chart overlay drawing, ink strokes, undo, export/import |
| `render.js` | Canvas rendering: terrain, fog reveal, markers, crosshair, compass, minimap |
| `game.js` | State, input, HUD state machine, persistence, game loop |
| `tests/contract.test.js` | 55 behavior tests covering noise, terrain, targets, alignment, resection, fog, height snapping |

## Tests

```bash
node --test tests/contract.test.js
```

## Tech

Zero dependencies. Six ES modules. Runs from any static file server.
