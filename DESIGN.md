# ATLASWRIGHT Design System

> *"The feeling of a map you drew by hand guiding a stranger safely home."*

## Aesthetic

**Organic/Natural.** Earth tones, rounded forms, hand-drawn texture, grain. The game is about hand-drawn maps, so the design feels hand-drawn too.

**Decoration:** Intentional — subtle paper grain, ink textures, soft edges. Not minimal (the map fantasy needs texture), not maximalist (contemplative, not chaotic).

## Color Palette

### Core

| Name | Hex | Usage |
|------|-----|-------|
| Background | `#12100c` | Warm near-black, aged paper in dim light |
| Surface | `rgba(18,16,12,0.88)` | Translucent dark panels |
| Parchment | `#ede8df` | Warm off-white, the paper your map is drawn on |
| Brass Gold | `#c08030` | Accent: compass, beacons, active elements |
| Amber Bright | `#e8a840` | Hover states, highlights, lit beacon glow |
| Ink Dark | `#1f1c18` | Chart lines, borders, text on parchment |
| Ink Muted | `#5a4a30` | Secondary text, subtle borders |
| Ink Light | `#b8a878` | Tertiary text, instructions, hints |

### Terrain

| Name | Hex | Biome |
|------|-----|-------|
| Water | `#2855a0` | Ocean |
| Sand | `#d2c39b` | Beach |
| Sage | `#6b9648` | Grass |
| Forest | `#3a7832` | Deep forest |
| Rock | `#8b7a50` | Exposed stone |
| Snow | `#e0e0db` | High peaks |

### Semantic

| Name | Hex | Usage |
|------|-----|-------|
| Success | `#3a6830` | Publish button, completion |
| Warning | `#c08030` | Reuses brass (consistent) |

## Typography

### Display: Instrument Serif
High-contrast serif with old-style figures. Evokes hand-lettered cartography. Loaded from Google Fonts. Used for: title, hero text, chart labels, landmark names.

### Body: Source Sans 3
Clean, readable sans-serif that doesn't compete with the serif. Good at small sizes for HUD elements. Used for: instructions, body text, UI labels.

### Data: JetBrains Mono
Monospace for coordinates, bearing degrees, fix errors. Tabular nums. Used for: compass readout, coordinates, fix error display.

## Spacing

4px base grid. Comfortable density. Game UI is compact (HUD overlays), chart needs breathing room.

## Layout

- **Game view:** Full-viewport canvas, HUD in corners
- **Chart overlay:** Centered panel, max-width 960px, parchment background
- **Start screen:** Centered card, generous whitespace, tagline as hero
- **Published chart:** Full-bleed, paper texture, chart as artifact

## Motion

Minimal-functional. Fade transitions between field/chart modes. Subtle crosshair color change on alignment. Beacon placement pulse. Nothing flashy — contemplative pace.

## Design Principles

1. **Instrument Serif for display** — Most games use sans-serif. A high-contrast serif says "this is a craft, not a product." It's unusual for games and immediately signals the hand-drawn-map fantasy.

2. **Paper grain texture on all surfaces** — Subtle SVG noise to panels and the chart. Makes every surface feel like physical paper. Costs ~2 lines of CSS.

3. **Chart as first-class artifact** — The published chart isn't a modal you close. It's a full-bleed paper document you can save. This breaks the "game UI closes when you're done" convention and makes the chart feel like a real deliverable.

## Implementation Notes

- CSS variables defined in `index.html` `:root`
- Google Fonts loaded via `<link>` preconnect
- Paper grain: CSS `background-image` with inline SVG noise at ~4% opacity
- All terrain colors from `world.js` match this palette
