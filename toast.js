// Transient #error toast — single showToast helper + named variant wrappers.
// Loaded before app.js; the ~30 call sites call showError/showSuccess/showWarning.

// Per-variant config. `styles` is the exact set of inline style writes applied
// on show (insertion order = write order). `reset` lists the style props the
// hide-timeout clears. The 'error' variant deliberately writes no borderColor
// and resets nothing on hide — preserving the original three functions' exact
// DOM-mutation sets (audit #1266).
const TOAST_VARIANTS = {
    error: {
        styles: { color: '', background: '' },
        timeout: 5000,
        reset: [],
    },
    success: {
        styles: {
            color: '#86efac',
            background: 'rgba(34, 197, 94, 0.15)',
            borderColor: 'rgba(34, 197, 94, 0.3)',
        },
        timeout: 4000,
        reset: ['color', 'background', 'borderColor'],
    },
    warning: {
        styles: {
            color: '#fcd34d',
            background: 'rgba(245, 158, 11, 0.15)',
            borderColor: 'rgba(245, 158, 11, 0.3)',
        },
        timeout: 5000,
        reset: ['color', 'background', 'borderColor'],
    },
};

function showToast(message, { variant = 'error' } = {}) {
    const config = TOAST_VARIANTS[variant];
    const el = document.getElementById('error');
    el.textContent = message;
    for (const [prop, value] of Object.entries(config.styles)) {
        el.style[prop] = value;
    }
    el.classList.add('active');
    setTimeout(() => {
        el.classList.remove('active');
        for (const prop of config.reset) {
            el.style[prop] = '';
        }
    }, config.timeout);
}

// Thin delegates — keep call sites byte-identical.
function showError(message) { showToast(message, { variant: 'error' }); }
function showSuccess(message) { showToast(message, { variant: 'success' }); }
function showWarning(message) { showToast(message, { variant: 'warning' }); }

// Browser script tags hoist top-level function declarations to window
// automatically. Explicit globalThis assignment makes the helpers loadable
// from non-script consumers (e.g. vm.runInThisContext in tests).
globalThis.TOAST_VARIANTS = TOAST_VARIANTS;
globalThis.showToast = showToast;
globalThis.showError = showError;
globalThis.showSuccess = showSuccess;
globalThis.showWarning = showWarning;
