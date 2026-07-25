// The header overflow menu — open/close, including the click-outside dismiss.
// Sole owner of the menu's open state; cloud-backup-ui.js calls
// closeOverflowMenuIfOpen() as a global after acting on one of its items.

function toggleOverflowMenu() {
    document.getElementById('overflowMenu').classList.toggle('open');
}

function closeOverflowMenuIfOpen() {
    const menu = document.getElementById('overflowMenu');
    if (menu) menu.classList.remove('open');
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('overflowMenu');
    const btn = document.getElementById('overflowBtn');
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
        menu.classList.remove('open');
    }
});

globalThis.toggleOverflowMenu = toggleOverflowMenu;
globalThis.closeOverflowMenuIfOpen = closeOverflowMenuIfOpen;
