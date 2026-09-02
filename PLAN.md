<!-- /autoplan restore point: /c/Users/mohni/.gstack/projects/game1/no-branch-autoplan-restore-20260902-161050.md -->
# ATLASWRIGHT — Next Phase Plan

## Current State
Working browser prototype: 6 ES modules (578 lines JS) + index.html (114 lines).
Core loop complete: explore → place beacons → take bearings → resection fix → chart → publish.
Zero dependencies, runs from any static file server.

## Phase 1: Bug Fixes (Must-Do)

### 1.1 Landmark height bug (P1 — correctness)
**File:** `world.js:42`
**Problem:** `landmarks.forEach(l => { l.y = Math.max(heightAt(l.x, l.z), 2) + 4 })` runs at module load time before `buildTerrain()` populates `heightMap`. Every landmark gets y=4 regardless of terrain.
**Fix:** Move height assignment into `game.js` after `buildTerrain()` completes, or make it a function called post-init.

### 1.2 calcExplored() throttle (P2 — performance)
**File:** `game.js:58`
**Problem:** `calcExplored()` iterates 1M-element fogMap every frame (60M iterations/sec).
**Fix:** Cache result, recompute only when player moves >1 world unit. Display cached value in HUD.

### 1.3 Minimap rebuild throttle (P2 — performance)
**File:** `renderer.js:127-135`
**Problem:** `renderMinimap()` creates new ImageData(160,160) and fills 25600 pixels every frame.
**Fix:** Cache minimap ImageData, rebuild only when player position changes by >1 pixel in minimap space.

### 1.4 Remove dead code (P3 — quality)
**Files:** `index.html` (btn-draw button), `world.js` (duplicated target filtering)
**Fix:** Remove `btn-draw` button (no handler exists). Extract `getUnrecordedTargets()` helper shared by `findNearestTarget()` and `isAligned()`.

## Phase 2: Visual Polish (High-Value)

### 2.1 Terrain shading
**Problem:** Flat pixel colors — no depth cues on slopes/ridges. Terrain reads as color mass.
**Fix:** Add slope-based darkening in renderer: compute height differential between neighboring pixels, darken pixels on steep slopes by 10-20%. This is the web equivalent of the Godot roughness=0.82 fix.

### 2.2 Apply approved design direction
**Status:** Design shotgun session produced 3 variants (Topographic Survey, Watercolor Expedition, Brass Instrument). No direction chosen yet.
**Action:** After user picks a direction from the comparison board, apply the chosen visual style to the renderer.

### 2.3 Fog of war edge softening
**Problem:** Hard edge between explored (alpha 255) and unexplored (alpha 40).
**Fix:** Add gradient falloff over 2-3 pixels at fog boundary for smoother reveal.

## Phase 3: Infrastructure (Foundation)

### 3.1 Initialize git repo
**Action:** `git init`, create `.gitignore` (node_modules, .env, *.log), initial commit of all files.

### 3.2 Add README.md
**Content:** Project description, controls, how to run, architecture overview (6 modules), known issues.

### 3.3 Add basic tests
**Action:** Create `tests/` directory with Node.js test files for:
- `noise.test.js` — seedRng determinism, noise2d range, fbm continuity
- `world.test.js` — heightAt island shape, findNearestTarget, isAligned, resection math
- `chart.test.js` — chartState management, publish flow

## Phase 4: Gameplay Enhancements (Stretch)

### 4.1 Sound design
- Footstep sounds on terrain (different per biome)
- Beacon placement chime
- Bearing recording tone
- Chart ink scratching sound

### 4.2 Mobile touch controls
- Virtual joystick for movement
- Touch-and-drag for camera look
- Tap to place beacon, long-press for bearing

### 4.3 Session history
- Save published charts to localStorage
- Gallery view of past expeditions
- Stats tracking (total beacons placed, fixes taken, charts published)

## Scope Boundaries

### In Scope
- Bug fixes from review
- Visual polish (terrain shading, fog softening)
- Infrastructure (git, README, tests)
- Design direction application

### Out of Scope (Explicitly Deferred)
- Multiplayer / shared maps
- Persistent world state beyond localStorage
- Server-side components
- Asset pipeline / build tools (staying zero-dependency)
- New gameplay mechanics beyond current loop

## Success Criteria
1. Zero known bugs (all P1/P2/P3 fixed)
2. Terrain reads as 3D (slope shading visible)
3. Git repo with clean history
4. Tests pass for core math (noise, resection, alignment)
5. README explains how to run and contribute

## Estimated Effort
- Phase 1 (bugs): ~2 hours
- Phase 2 (visual): ~3 hours
- Phase 3 (infra): ~1 hour
- Phase 4 (stretch): ~4 hours
- **Total: ~10 hours**
