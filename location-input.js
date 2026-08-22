// Start-location input — parse coordinates, geocode addresses, read the device
// location, and resolve the field into a validated start point. Loaded after
// net.js (fetchWithTimeout), bbox.js (inFinland) and toast.js; resolved as
// globals at call time.

function parseLocation(input) {
    input = input.trim();
    const coordRegex = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;
    const match = input.match(coordRegex);
    if (match) {
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            return { lat, lng, isAddress: false };
        }
        throw new Error('Invalid coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.');
    }
    return { address: input, isAddress: true };
}

async function geocodeAddress(address) {
    const response = await fetchWithTimeout(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`
    );
    if (!response.ok) {
        throw new Error('Address lookup is busy — try again in a moment, or use coordinates.');
    }
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`Could not find location: "${address}". Try being more specific or use coordinates instead.`);
    }
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

function useMyLocation() {
    const btn = document.getElementById('useLocationBtn');
    if (!navigator.geolocation) {
        showError('Geolocation is not supported by your browser.');
        return;
    }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            document.getElementById('location').value =
                `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
            btn.disabled = false;
        },
        (err) => {
            showError('Could not get your location: ' + err.message);
            btn.disabled = false;
        },
        { timeout: 10000 }
    );
}

// Read the location field and turn it into { startLat, startLng, locationInput }.
// Throws (with a user-facing message) on an empty field, unparseable input, a
// geocode miss, or a start outside Finland — the routing backend only covers FI.
async function resolveStart() {
    const locationInput = document.getElementById('location').value.trim();
    if (!locationInput) throw new Error('Please enter a starting location.');
    const locationData = parseLocation(locationInput);
    let startLat, startLng;
    if (locationData.isAddress) {
        const coords = await geocodeAddress(locationData.address);
        startLat = coords.lat; startLng = coords.lng;
    } else {
        startLat = locationData.lat; startLng = locationData.lng;
    }
    if (!inFinland(startLat, startLng)) {
        throw new Error('Wander only routes within Finland — pick a starting location inside the country.');
    }
    return { startLat, startLng, locationInput };
}

globalThis.parseLocation = parseLocation;
globalThis.geocodeAddress = geocodeAddress;
globalThis.useMyLocation = useMyLocation;
globalThis.resolveStart = resolveStart;
