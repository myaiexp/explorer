# CLAUDE.md

## Project Overview

**Wander** — a static web app for generating random walking/exploration destinations. Pick a starting location and radius, get a random POI or point, see a routed round-trip or one-way path on a Leaflet map.

## Architecture

No build step, no bundler, no framework. Source files served as-is:

- `index.html` — structure
- `style.css` — styles
- `app.js` — all application logic (~85KB single file)
- `fit-encoder.js` — Garmin FIT course-file encoder (used by `exportFIT()` in app.js)

`tools/` holds dev-only tooling (FIT round-trip validators using `@garmin/fitsdk`, browser smoke-test page). Has its own `package.json` and `node_modules`; not referenced by `index.html` and not part of the deployed site.

**Core logic flow:**

1. User enters a starting location (address or lat/lng) and a max distance in km
2. Address inputs are geocoded via Nominatim
3. A destination is picked: random POI from Overpass (categorized: nature, food, activity, culture, or "any"), random road point, or fully random point
4. OSRM calculates a walking route; round-trip mode builds a loop with geometric via points (spread slider controls loop width), smart routing optionally snaps vias to nearby roads
5. Result shown on Leaflet map with markers, route polylines, elevation profile chart, distance/duration badges, Google Maps directions link

**Key features:** saved locations, favorites/bookmarks, visit history with map overlay, GPX export, Garmin FIT export (course file with turn cues from OSRM steps), route sharing via URL, "Surprise me" button, Overpass rate-limit handling with retry logic, XSS protection on URL parameters, localStorage persistence of all settings.

## Development

No build step. To serve locally:

```bash
python3 -m http.server 8080
# or
npx serve .
```

Deploy by pushing to the `production` git remote.
