// Route elevation profile — Open-Meteo sampling + hand-built SVG chart. Holds no
// map or route-color state of its own: the chart color is passed in by the
// caller. Loaded after net.js (for fetchWithTimeout) and geo-utils.js (for
// haversineM); export.js uses fetchElevations for FIT export. Sampling is an
// Open-Meteo URL-length budget — the public contract is one altitude per
// input coord, interpolated by distance along the path.

// Tighter than net.js's 20 s default: elevation is optional decoration on the map
// path, but confirmFITExport AWAITS it after the modal has already closed — so a
// stalled Open-Meteo leaves the user clicking "Download .fit" with no file, no
// error, and no spinner until this fires. Better to drop the profile quickly than
// to hold the export hostage.
const ELEVATION_TIMEOUT_MS = 10000;

// Vertex indices sent to Open-Meteo: every `step` along the polyline, plus the
// last vertex so the series always covers the full path.
function sampleRouteIndices(n, maxPts = 100) {
    if (n <= 0) return [];
    const step = Math.max(1, Math.floor(n / maxPts));
    const indices = [];
    for (let i = 0; i < n; i += step) indices.push(i);
    if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);
    return indices;
}

function lerpElevation(e0, e1, t) {
    if (e0 == null && e1 == null) return 0;
    if (e0 == null) return e1;
    if (e1 == null) return e0;
    return e0 + t * (e1 - e0);
}

// Stretch a sampled elevation series back onto every vertex of `coords` by
// distance along the path. Returns null if the sample counts don't line up —
// callers treat null as "no elevation" rather than a misaligned series.
function expandElevations(coords, sampledElevations, sampleIndices) {
    if (!sampledElevations || !sampleIndices) return null;
    if (sampledElevations.length !== sampleIndices.length) return null;
    if (sampleIndices.length === 0) return coords.length === 0 ? [] : null;
    if (sampledElevations.length === coords.length) return sampledElevations;

    const n = coords.length;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + haversineM(
            coords[i - 1][0], coords[i - 1][1],
            coords[i][0], coords[i][1],
        );
    }

    const out = new Array(n);
    let s = 0;
    const lastS = sampleIndices.length - 1;
    for (let i = 0; i < n; i++) {
        while (s < lastS && cum[sampleIndices[s + 1]] < cum[i]) s++;
        if (s >= lastS) {
            out[i] = sampledElevations[lastS];
            continue;
        }
        const d0 = cum[sampleIndices[s]];
        const d1 = cum[sampleIndices[s + 1]];
        const span = d1 - d0;
        const t = span <= 0 ? 0 : Math.min(1, Math.max(0, (cum[i] - d0) / span));
        out[i] = lerpElevation(sampledElevations[s], sampledElevations[s + 1], t);
    }
    return out;
}

// Sample up to 100 points for the Open-Meteo request, then interpolate the
// series back onto every input coord. Returns one elevation per coord, or null
// on a non-OK / unusable response; rejects if the request times out (every
// caller already treats a rejection as "no elevation" and carries on).
async function fetchElevations(coords) {
    const indices = sampleRouteIndices(coords.length);
    const sampled = indices.map(i => coords[i]);

    const lats = sampled.map(c => c[0].toFixed(4)).join(',');
    const lngs = sampled.map(c => c[1].toFixed(4)).join(',');
    const res = await fetchWithTimeout(
        `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`,
        {},
        ELEVATION_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return expandElevations(coords, data.elevation || null, indices);
}

// Render the elevation profile SVG (gradient area + line + gain/loss/range stats)
// into #elevationContainer, styled with `color`. Clears the container and hides
// it when there are fewer than two samples.
function renderElevationChart(elevations, color) {
    const container = document.getElementById('elevationContainer');
    container.replaceChildren();
    if (!elevations || elevations.length < 2) {
        container.classList.remove('active');
        return;
    }

    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    const range = max - min || 1;
    const w = 300;
    const h = 64;
    const pad = 1;

    const pts = elevations.map((e, i) => {
        const x = (i / (elevations.length - 1)) * w;
        const y = h - pad - ((e - min) / range) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const linePath = pts.join(' L');
    const areaPath = `M0,${h} L${pts[0]} L${linePath} L${w},${h} Z`;

    let gain = 0, loss = 0;
    for (let i = 1; i < elevations.length; i++) {
        const diff = elevations[i] - elevations[i - 1];
        if (diff > 0) gain += diff;
        else loss -= diff;
    }

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'elevation-chart');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'elevGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const chartColor = color;
    const stop1 = document.createElementNS(NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', chartColor);
    stop1.setAttribute('stop-opacity', '0.4');
    const stop2 = document.createElementNS(NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', chartColor);
    stop2.setAttribute('stop-opacity', '0.05');
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'url(#elevGrad)');
    svg.appendChild(area);

    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', chartColor);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);

    container.appendChild(svg);

    const stats = document.createElement('div');
    stats.className = 'elevation-stats';
    const rangeStat = document.createElement('span');
    rangeStat.textContent = `${Math.round(min)}–${Math.round(max)} m`;
    const gainStat = document.createElement('span');
    gainStat.textContent = `↑ ${Math.round(gain)} m`;
    const lossStat = document.createElement('span');
    lossStat.textContent = `↓ ${Math.round(loss)} m`;
    stats.appendChild(rangeStat);
    stats.appendChild(gainStat);
    stats.appendChild(lossStat);
    container.appendChild(stats);

    container.classList.add('active');
}

globalThis.fetchElevations = fetchElevations;
globalThis.renderElevationChart = renderElevationChart;
