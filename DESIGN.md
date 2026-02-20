# Design System — Wander / Explorer

A minimal dark-mode UI designed for tool-like apps: data-dense, keyboard-friendly, no decorative chrome.

---

## Fonts

Load from Google Fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
```

- **UI font**: `DM Sans` — clean, slightly geometric sans. Used for all body text, labels, buttons.
- **Mono font**: `JetBrains Mono` — for coordinates, codes, data values.
- Base size: `14px`, antialiased (`-webkit-font-smoothing: antialiased`)

---

## Color Tokens

```css
:root {
    --bg: #1a1a1a;           /* main background */
    --bg-deep: #0f0f0f;      /* deepest bg — top bar, page background */
    --surface: #252525;      /* cards, inputs, raised elements */
    --border: #333;          /* all borders */
    --text: #e5e5e5;         /* primary text */
    --text-secondary: #888;  /* labels, hints, secondary info */
    --accent: #3b82f6;       /* primary blue — buttons, focus rings, links */
    --accent-hover: #2563eb; /* darker blue on hover */
    --success: #22c55e;      /* green — confirmations, "visited" state */
    --error: #ef4444;        /* red — errors, destructive/active toggle */
    --radius: 6px;           /* default border-radius */
}
```

Tinted backgrounds for status indicators use low-opacity versions of semantic colors:
- Error bg: `rgba(239, 68, 68, 0.15)` with `rgba(239, 68, 68, 0.3)` border
- Badge backgrounds: `rgba(59, 130, 246, 0.15)`, `rgba(34, 197, 94, 0.15)`

---

## Layout

### App Shell
Full-viewport column layout with a fixed top bar and a flex content area below:

```
┌─────────────────────────────────┐  ← top-bar (40px, border-bottom)
│                                 │
│  ┌──────────┐  ┌─────────────┐  │  ← main (flex-row on desktop)
│  │  panel   │  │   content   │  │
│  │  (360px) │  │   (flex: 1) │  │
│  └──────────┘  └─────────────┘  │
└─────────────────────────────────┘
```

On mobile (`< 768px`): panel moves below content, capped at `45vh`, scrollable.
On desktop (`≥ 768px`): panel is a left sidebar, `360px` wide, full height.

```css
/* Mobile-first: panel below */
.main { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.panel { flex-shrink: 0; max-height: 45vh; border-top: 1px solid var(--border); }

@media (min-width: 768px) {
    .main { flex-direction: row; }
    .panel { order: -1; width: 360px; max-height: none; border-top: none; border-right: 1px solid var(--border); }
}
```

### Top Bar
Height `40px`, `padding: 0 12px`. Brand name on the left, actions on the right.
Background: `--bg-deep`. Always use `flex-shrink: 0` and `z-index: 100`.

---

## Typography

| Use | Size | Weight | Color | Notes |
|-----|------|--------|-------|-------|
| Brand name | 15px | 600 | `--text` | `letter-spacing: -0.01em` |
| Body / inputs | 14px | 400 | `--text` | |
| Buttons | 14px | 600 (primary), 500 (ghost) | — | |
| Form labels | 12px | 500 | `--text-secondary` | `text-transform: uppercase`, `letter-spacing: 0.04em` |
| Section headers | 11px | 600 | `--text-secondary` | `text-transform: uppercase`, `letter-spacing: 0.06em` |
| Small/secondary | 12–13px | 500 | `--text-secondary` | |
| Monospace data | 13px | 400 | `--text` | JetBrains Mono |

---

## Components

### Inputs

```css
input[type="text"],
input[type="number"] {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    font-size: 14px;
    color: var(--text);
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
}
input:focus { border-color: var(--accent); }
input::placeholder { color: #555; }
```

Inputs sit inside `.input-group` (flex column, `gap: 6px`) with a `<label>` above.

### Buttons

**Primary** — filled blue, full-width in action rows:
```css
.btn-primary {
    padding: 10px 16px;
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 600;
    transition: background 0.15s;
}
.btn-primary:hover { background: var(--accent-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
/* Active/destructive toggle state: */
.btn-primary.active { background: var(--error); }
```

**Ghost** — transparent with border:
```css
.btn-ghost {
    padding: 10px 16px;
    background: none;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 14px;
    font-weight: 500;
    transition: color 0.15s, border-color 0.15s;
}
.btn-ghost:hover { color: var(--text); border-color: var(--text-secondary); }
```

**Icon button** — square, 28–36px, no fill:
```css
.icon-btn {
    display: flex; align-items: center; justify-content: center;
    width: 36px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    transition: color 0.15s, border-color 0.15s;
}
.icon-btn:hover { color: var(--accent); border-color: var(--accent); }
```

**Action row** — primary + ghost side by side:
```html
<div class="action-row"> <!-- display:flex; gap:8px -->
    <button class="btn-primary" style="flex:1">Primary</button>
    <button class="btn-ghost">Secondary</button>
</div>
```

> **Important:** Never use `<label>` styled as a button — browsers apply inconsistent UA styles. Always use real `<button>` elements.

### Pill Toggle (Radio Group)

Segmented control from hidden radio inputs:

```css
.radio-group {
    display: flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
}
.radio-option {
    flex: 1; display: flex; align-items: center; justify-content: center;
    padding: 7px 12px; font-size: 13px; color: var(--text-secondary);
    cursor: pointer; transition: background 0.15s, color 0.15s;
}
.radio-option + .radio-option { border-left: 1px solid var(--border); }
.radio-option input[type="radio"] { position: absolute; opacity: 0; width: 0; height: 0; }
.radio-option:has(input:checked) { background: var(--accent); color: #fff; font-weight: 500; }
.radio-option:hover:not(:has(input:checked)) { background: rgba(255,255,255,0.04); color: var(--text); }
```

### Slider

Custom-styled range input, `4px` track, `14px` accent-colored thumb:

```css
input[type="range"] {
    flex: 1; height: 4px;
    -webkit-appearance: none; appearance: none;
    background: var(--border); border-radius: 2px;
    outline: none; cursor: pointer;
}
input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px; height: 14px; border-radius: 50%;
    background: var(--accent); border: none;
}
```

Wrap in a `.slider-row` (flex, `gap: 6px`) with small text labels on each end.

### Cards / Surfaces

```css
.result-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
}
```

Section header inside card:
```css
.result-header {
    font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-secondary);
    margin-bottom: 8px;
}
```

Monospace data block inside card:
```css
.coordinates {
    font-family: var(--mono); font-size: 13px;
    padding: 6px 8px;
    background: rgba(255,255,255,0.04);
    border-radius: 4px;
}
```

### Badges

Small inline pill indicators:
```css
.badge {
    font-size: 12px; font-weight: 500;
    padding: 4px 8px; border-radius: 4px;
}
.badge-blue  { background: rgba(59,130,246,0.15); color: var(--accent); }
.badge-green { background: rgba(34,197,94,0.15);  color: var(--success); }
```

### Dropdown Menu

Attached to an icon button in the top bar:

```css
.overflow-menu {
    position: absolute; top: 100%; right: 0; margin-top: 4px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 4px;
    min-width: 160px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.overflow-menu button {
    display: block; width: 100%; text-align: left;
    padding: 8px 12px; background: none; border: none;
    color: var(--text); font-size: 13px; border-radius: 4px;
    transition: background 0.1s;
}
.overflow-menu button:hover { background: rgba(255,255,255,0.06); }
```

Toggle with a `.open` class (or `display: none` / `display: block`).

### Loading State

Pulsing dot + message:
```css
.loading-pulse {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
    0%, 100% { opacity: 0.3; transform: scale(0.8); }
    50%       { opacity: 1;   transform: scale(1.2); }
}
```

### Error State

```css
.error {
    padding: 8px 10px; border-radius: var(--radius); font-size: 13px;
    background: rgba(239,68,68,0.15);
    color: #fca5a5;
    border: 1px solid rgba(239,68,68,0.3);
}
```

### Scrollbar

Thin, unobtrusive:
```css
.scrollable::-webkit-scrollbar       { width: 4px; }
.scrollable::-webkit-scrollbar-track { background: transparent; }
.scrollable::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
```

---

## Spacing & Sizing Reference

| Token | Value |
|-------|-------|
| Panel padding | `14–16px` |
| Gap between form sections | `12–14px` |
| Gap within input group | `6px` |
| Gap in action rows | `8px` |
| Border radius | `6px` (components), `4px` (inner elements like badges, mono blocks) |
| Top bar height | `40px` |
| Transition duration | `0.15s` (most), `0.1s` (hover bg fills) |

---

## Design Principles

1. **Dark but not heavy** — `#1a1a1a` bg with `#252525` surfaces creates clear layering without high contrast fatigue.
2. **Borders over shadows** — `1px solid #333` everywhere instead of drop shadows. Shadows only for floating menus (`box-shadow: 0 8px 24px rgba(0,0,0,0.4)`).
3. **Accent sparingly** — blue accent only on primary CTA, focused inputs, and active states. Don't scatter it.
4. **Uppercase labels** — small `12px` uppercase labels with wide tracking identify form fields without taking space.
5. **No spinners on number inputs** — hide native browser spinners, replace with custom `+`/`-` buttons if needed, or leave clean.
6. **Semantic color for state** — success green for confirmations/completed actions, error red for destructive/active-cancel states.
