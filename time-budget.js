// Time budget — the minutes field beside max distance. Minutes and max km are
// one budget at walking pace; an empty minutes field leaves km the source of
// truth. Binds its listeners at load, so it needs #maxDistance and #maxMinutes
// in the DOM; its stepper calls stepNumInput (form-controls.js) at call time.

// 5 km/h — the pace behind the walk-duration badge and fit-encoder's WALK_MPS.
const BUDGET_KM_PER_MIN = 5 / 60;

const budgetKmInput = document.getElementById('maxDistance');
const budgetMinutesInput = document.getElementById('maxMinutes');

// A positive number, or null for '', NaN, zero and negatives. A number input's
// value is '' for anything it cannot parse, so null also covers "mid-edit".
function positiveOrNull(raw) {
    const n = parseFloat(raw);
    return n > 0 ? n : null;
}

// One decimal: 0.05 km is 36 s of walking.
function minutesToRawKm(minutes) {
    return Math.round(minutes * BUDGET_KM_PER_MIN * 10) / 10;
}

// Clamped to #maxDistance's own min/max so a long minutes value cannot produce
// a km the generate form would refuse.
function clampBudgetKm(km) {
    const lo = parseFloat(budgetKmInput.min);
    const hi = parseFloat(budgetKmInput.max);
    if (!isNaN(lo)) km = Math.max(lo, km);
    if (!isNaN(hi)) km = Math.min(hi, km);
    return km;
}

function kmToMinutes(km) {
    return Math.round(km / BUDGET_KM_PER_MIN);
}

// Writes are plain value assignments, not events, so the two input listeners
// never trigger each other.
budgetMinutesInput.addEventListener('input', () => {
    const minutes = positiveOrNull(budgetMinutesInput.value);
    if (minutes != null) budgetKmInput.value = clampBudgetKm(minutesToRawKm(minutes));
});

// While typing, an out-of-range minutes value stays as typed (the km behind it
// is already clamped) — rewriting it mid-keystroke would fight the user. On
// commit, show the minutes the clamped km actually buys.
budgetMinutesInput.addEventListener('change', () => {
    const minutes = positiveOrNull(budgetMinutesInput.value);
    if (minutes == null) return;
    const km = minutesToRawKm(minutes);
    const clamped = clampBudgetKm(km);
    if (clamped !== km) budgetMinutesInput.value = kmToMinutes(clamped);
});

budgetKmInput.addEventListener('input', () => {
    if (budgetMinutesInput.value === '') return;
    const km = positiveOrNull(budgetKmInput.value);
    if (km != null) budgetMinutesInput.value = kmToMinutes(km);
});

// The minutes steppers. Stepping an empty field from 0 would clamp to the
// field's min and drag km down to 0.5, so an empty field first takes the
// minutes the current km buys. stepNumInput (form-controls.js) is resolved at
// call time and fires the input event the listener above converts.
function stepBudgetMinutes(delta) {
    const km = positiveOrNull(budgetKmInput.value);
    if (budgetMinutesInput.value === '' && km != null) {
        budgetMinutesInput.value = kmToMinutes(km);
    }
    stepNumInput('maxMinutes', delta);
}

globalThis.stepBudgetMinutes = stepBudgetMinutes;
