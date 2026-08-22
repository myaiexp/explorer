// Route file export — GPX + Garmin FIT course files and the FIT modal open/close.
// Reads the active route via getCurrentSession() (session-state.js) and turns it
// into a downloadable file; uses FitEncoder (fit-encoder.js) and fetchElevations
// (elevation.js). The functions are called from index.html onclick handlers as
// globals; the FIT modal owns its own Escape wiring at the bottom of this file.

function exportGPX() {
    const session = getCurrentSession();
    if (!session) return;
    const { destName, routeCoords, returnRouteCoords } = session;
    const name = destName || 'Wander route';
    const allCoords = mergeRouteCoords(routeCoords, returnRouteCoords);
    if (allCoords.length === 0) { showError('No route data to export.'); return; }

    const trkpts = allCoords.map(([lat, lng]) =>
        `      <trkpt lat="${lat}" lon="${lng}"></trkpt>`
    ).join('\n');

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wander"
     xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name.replace(/[<>&]/g, '')}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

    triggerDownload(gpx, name, 'gpx', 'application/gpx+xml');
}

function openFITModal() {
    if (!getCurrentSession()) { showError('Generate a route first.'); return; }
    if (typeof FitEncoder === 'undefined') { showError('FIT encoder not loaded.'); return; }
    document.getElementById('fitModal').classList.add('active');
}

function closeFITModal() {
    document.getElementById('fitModal').classList.remove('active');
}

async function confirmFITExport() {
    const session = getCurrentSession();
    if (!session) { showError('Generate a route first.'); return; }
    closeFITModal();

    const { destName, routeCoords, returnRouteCoords, routeSteps, returnRouteSteps } = session;
    const coords = mergeRouteCoords(routeCoords, returnRouteCoords);
    if (coords.length < 2) { showError('No route data to export.'); return; }

    const steps = [...(routeSteps || []), ...(returnRouteSteps || [])];
    const coursePoints = FitEncoder.osrmStepsToCoursePoints(coords, steps);

    let elevations = null;
    try { elevations = await fetchElevations(coords); } catch { /* optional */ }
    // encodeCourse indexes elevations[i] as coords[i]. A sampled Open-Meteo
    // series is the wrong length; dropping it omits altitude rather than
    // stamping the tail of the course as sea level (finding #7300).
    if (elevations && elevations.length !== coords.length) elevations = null;

    const name = destName || 'Wander route';
    const bytes = FitEncoder.encodeCourse({ name, coords, coursePoints, elevations });
    triggerDownload(bytes, name, 'fit', 'application/vnd.ant.fit');
}

// Concatenate outbound + return route coords, dropping the duplicate destination
// point (last of outbound == first of return, within 1 m).
function mergeRouteCoords(out, ret) {
    const a = out || [];
    const b = ret || [];
    if (a.length === 0) return b.slice();
    if (b.length === 0) return a.slice();
    const [aLat, aLng] = a[a.length - 1];
    const [bLat, bLng] = b[0];
    const dup = Math.abs(aLat - bLat) < 1e-5 && Math.abs(aLng - bLng) < 1e-5;
    return dup ? a.concat(b.slice(1)) : a.concat(b);
}

// Trigger a browser download of `data`. By default the file is named by
// sanitizing `name` into `<slug>.<ext>`; pass an explicit `filename` when the
// caller already has the exact name (e.g. the date-stamped visits backup, whose
// hyphens/dots the sanitizer would mangle).
function triggerDownload(data, name, ext, mime, filename) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename ||
        `${name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-').toLowerCase() || 'route'}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
}

// The FIT modal owns its own Escape wiring (prefs-modal.js does the same for the
// preferences modal) instead of one shared handler in the entry point.
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('fitModal')?.classList.contains('active')) {
        closeFITModal();
    }
});

globalThis.exportGPX = exportGPX;
globalThis.openFITModal = openFITModal;
globalThis.closeFITModal = closeFITModal;
globalThis.confirmFITExport = confirmFITExport;
globalThis.mergeRouteCoords = mergeRouteCoords;
globalThis.triggerDownload = triggerDownload;
