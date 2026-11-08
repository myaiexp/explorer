// Form controls — the number-input steppers, the trip-mode distance label, and
// the keyboard shortcuts that trigger a build. Loaded after generate.js
// (generateDestination) and route-view.js (syncDistanceLabel); the label helper
// is resolved as a global at call time.

function stepNumInput(id, delta) {
    const input = document.getElementById(id);
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    let val = (parseFloat(input.value) || 0) + delta;
    if (!isNaN(min)) val = Math.max(min, val);
    if (!isNaN(max)) val = Math.min(max, val);
    input.value = val;
    // A stepper click is a user edit: the minutes↔km sync listens for input,
    // settings persistence for change. A bare value write fires neither.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Distance means different things per trip mode — label it so the number the
// user types matches what they get.
document.querySelectorAll('input[name="tripMode"]').forEach(radio => {
    radio.addEventListener('change', () => syncDistanceLabel());
});

// Enter in any of the four inputs, or Ctrl/Cmd+Enter anywhere, generates.
// These bypass the (disabled) generate button entirely — generateDestination's
// own in-flight guard is what keeps them from starting a concurrent build.
for (const id of ['location', 'minDistance', 'maxDistance', 'maxMinutes']) {
    document.getElementById(id).addEventListener('keypress', e => {
        if (e.key === 'Enter') generateDestination();
    });
}

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generateDestination();
    }
});

globalThis.stepNumInput = stepNumInput;
