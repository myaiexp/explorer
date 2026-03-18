# Ideas

> Feature ideas, improvements, tech debt, and things worth revisiting.

## High Priority

**Time-based mode** — "I have 45 minutes" toggle alongside distance input. Uses ~5 km/h estimate to convert. Worth designing together with cycling router as a transport mode system.

**Cycling router** — OSRM has a cycling profile (`routed-bike`). Transport mode toggle (walk/bike) switches the OSRM endpoint. Ties into time-based mode since speed differs.

## Future

**Multi-stop routes** — "Walk me past 3 cafes in a loop" — fetch N POIs, rough TSP ordering, route through all. Natural evolution of single-destination model.

**Coverage heatmap** — Leaflet.heat plugin overlay from stored route coordinates. Makes destination novelty scoring visible, creates "fill the map" motivation.

**PWA / offline support** — Service worker for tile caching + app manifest for installability.

**Stats dashboard** — Total km walked, unique POIs visited, area coverage, monthly activity. All derivable from existing localStorage data.

**Weather-aware suggestions** — Weather API check before generating. Bias toward indoor POIs when raining, or show weather badge on result card.

- **Better mobile panel** — drag-to-resize handle or collapsible panel instead of fixed 45vh cap

## Tech Debt

<!-- Fragile patterns, latent bugs, things that work but could be better -->

## Implemented

- Saved starting locations, GPX export, route sharing via URL
- POI categories + "any POI", remember last settings, Ctrl+Enter shortcut
- Delete history entries, undo "mark as visited"
- Removed broken route overlap scoring (destination novelty kept)
- Elevation profile, favorites/bookmarks, "Surprise me" button
- Smart loop routing, SRI hashes, XSS fix
