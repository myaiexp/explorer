// Route elevation profile — Open-Meteo sampling + hand-built SVG chart. Holds no
// map or route-color state of its own: the chart color is passed in by the
// caller, keeping this module DOM-only and dependency-free. Loaded before app.js
// (and before export.js, which uses fetchElevations for FIT export); used there
// as globals.

// Sample up to 100 points evenly along the route and fetch their elevations from
// Open-Meteo. Returns the elevation array, or null on a non-OK response.
async function fetchElevations(coords) {
    // Sample up to 100 points evenly along the route
    const maxPts = 100;
    const step = Math.max(1, Math.floor(coords.length / maxPts));
    const sampled = [];
    for (let i = 0; i < coords.length; i += step) sampled.push(coords[i]);
    if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
        sampled.push(coords[coords.length - 1]);
    }

    const lats = sampled.map(c => c[0].toFixed(4)).join(',');
    const lngs = sampled.map(c => c[1].toFixed(4)).join(',');
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.elevation || null;
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
