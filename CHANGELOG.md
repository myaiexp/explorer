# Changelog

## [1.0.0] - 2026-03-28

### New Features
- Added smart loop routing with road-sourced waypoints and u-turn mitigation
- Added snap-to-road option for loop waypoints
- Added elevation profile chart to route results
- Added favorites/bookmarks for destinations
- Added "Surprise me" quick-start button
- Added Google Maps walking directions link
- Added POI category selection and one-way trip mode
- Added visit history tracking with map overlay
- Added request delay control slider

### Bug Fixes
- Fixed reflected XSS vulnerability via URL hash parameter
- Fixed Overpass API rate limiting with retry logic and fallback
- Fixed loop waypoints missing from Google Maps directions URL
- Added SRI hashes to external Leaflet CDN tags
- Added cache-busting query strings to JS and CSS files

### Improvements
- Made smart routing opt-in with faster default search
- Cleaned up result card layout
- Replaced broken route overlap scoring with backtracking detection

### Documentation
- Standardized documentation structure with .claude/plans and ideas.md
- Added Claude Code project documentation
- Formatted DESIGN.md tables with improved spacing
- Added road-aware routing implementation plan
