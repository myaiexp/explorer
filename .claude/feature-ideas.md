# Feature Ideas

> From initial analysis session. Organized by impact and feasibility.
> Items marked ✅ were implemented. Remaining items are open for future work.

---

## Implemented ✅

- **Saved starting locations** — star button saves/names locations, shown as chips below input
- **GPX export** — "GPX" link in result card downloads current route as .gpx
- **Route sharing via URL** — "Copy link" encodes start/dest/mode in URL hash, auto-restores on load
- **POI categories + "any POI"** — grouped optgroups (Nature, Food & Drink, Activity, Culture) plus "any POI" that queries all types in one Overpass request
- **Remember last settings** — location, distance, POI type, spread, delay, trip mode persist via localStorage
- **Ctrl+Enter shortcut** — global shortcut to generate from anywhere on page
- **Delete history entries** — X button appears on hover
- **Undo "mark as visited"** — click "Visited!" again to unmark
- **Removed broken route overlap scoring** — chirality comparison and `scoreRouteOverlap` were ineffective (OSRM produces similar routes regardless of via-point side, sparse sampling gave near-zero hit rates). Destination novelty (`pickMostNovelDestination`) kept — it works.
- **Elevation profile** — Open-Meteo API samples heights along route, renders SVG chart in result card
- **Favorites/bookmarks** — heart button saves destinations, shown in dedicated section
- **"Surprise me" button** — randomizes all settings and generates
- **Smart loop routing** — road-sourced vias with u-turn mitigation, opt-in for higher quality round trips
- **SRI hashes** on Leaflet CDN tags
- **XSS fix** — sanitize URL hash `destName` parameter

---

## Not yet implemented

### High value

**Time-based mode** — "I have 45 minutes" toggle alongside distance input. Uses ~5 km/h estimate to convert. Worth designing together with cycling router as a transport mode system.

**Cycling router** — OSRM has a cycling profile (`routed-bike`). Transport mode toggle (walk/bike) switches the OSRM endpoint. Ties into time-based mode since speed differs.

### Medium effort, high reward

**Multi-stop routes** — "Walk me past 3 cafes in a loop" — fetch N POIs, rough TSP ordering, route through all. Natural evolution of single-destination model.

**Coverage heatmap** — Leaflet.heat plugin overlay from stored route coordinates. Makes destination novelty scoring visible, creates "fill the map" motivation.

### Bigger lifts

**PWA / offline support** — Service worker for tile caching + app manifest for installability.

**Stats dashboard** — Total km walked, unique POIs visited, area coverage, monthly activity. All derivable from existing localStorage data.

**Weather-aware suggestions** — Weather API check before generating. Bias toward indoor POIs when raining, or show weather badge on result card.

### Small polish

- **Better mobile panel** — drag-to-resize handle or collapsible panel instead of fixed 45vh cap
