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
| E | Take bearing on nearest target |
| F | Plot fix on chart |
| TAB | Open/close chart |
| Z | Undo last stroke |
| ESC | Close chart |

## Project Structure

| File | Purpose |
|------|---------|
| `index.html` | Game page, HUD, chart overlay, CSS |
| `noise.js` | Seeded simplex noise and fractal Brownian motion |
| `world.js` | Terrain, fog, landmarks, beacons, bearings, resection — pure logic, zero DOM |
| `game.js` | State, input, rendering, chart, game loop — all DOM |
| `tests/contract.test.js` | 25 behavior tests covering noise, terrain, targets, resection, fog |

## Tests

```bash
node --test tests/contract.test.js
```

## Tech

Zero dependencies. Three ES modules. Runs from any static file server.
