// Cloud-backup UI — consent toast plus the overflow-menu sync controls.

// WanderSync lives in sync.js; showError/showSuccess in toast.js — both loaded
// before this and used as globals.

function showConsentToast() {
    return new Promise((resolve) => {
        if (document.getElementById('cloudConsentToast')) {
            resolve('declined');
            return;
        }

        const toast = document.createElement('div');
        toast.className = 'toast-consent';
        toast.id = 'cloudConsentToast';

        const msg = document.createElement('div');
        msg.className = 'toast-consent-message';
        msg.textContent =
            'Wander can save your visits, saved locations, and favorites ' +
            'to a database on mase.fi so they survive clearing your browser.';
        toast.appendChild(msg);

        const buttons = document.createElement('div');
        buttons.className = 'toast-consent-buttons';

        const declineBtn = document.createElement('button');
        declineBtn.type = 'button';
        declineBtn.textContent = 'Decline';

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'primary';
        acceptBtn.textContent = 'Accept';

        let settled = false;
        let autoTimer;
        const settle = (choice) => {
            if (settled) return;
            settled = true;
            clearTimeout(autoTimer);
            toast.remove();
            resolve(choice);
        };

        declineBtn.addEventListener('click', () => {
            WanderSync.decline();
            settle('declined');
        });
        acceptBtn.addEventListener('click', () => {
            if (settled) return;
            // Drop the auto-decline timer as soon as Accept is in flight —
            // otherwise a slow POST /accounts that straddles the 30s mark
            // would persist declined on top of (or instead of) the accept.
            clearTimeout(autoTimer);
            acceptBtn.disabled = true;
            declineBtn.disabled = true;
            acceptBtn.textContent = 'Saving…';
            WanderSync.accept().then(() => {
                showSuccess('Cloud backup enabled.');
                settle('accepted');
            }).catch((err) => {
                console.warn('Cloud backup enable failed', err);
                showError('Could not enable cloud backup. Try again later.');
                settle('declined');
            });
        });

        buttons.appendChild(declineBtn);
        buttons.appendChild(acceptBtn);
        toast.appendChild(buttons);

        autoTimer = setTimeout(() => {
            if (!settled) {
                WanderSync.decline();
                settle('declined');
            }
        }, 30000);
        document.body.appendChild(toast);
    });
}

window.WanderSyncUI = { showConsentToast };

function enableCloudBackup() {
    closeOverflowMenuIfOpen();
    WanderSync.requestConsent();
}

function copyBackupLink() {
    closeOverflowMenuIfOpen();
    const link = WanderSync.getState().link;
    if (!link) { showError('No backup link available.'); return; }
    navigator.clipboard.writeText(link).then(
        () => showSuccess('Backup link copied — open it on any device to restore your data.'),
        () => showError('Failed to copy link.')
    );
}

function confirmDeleteCloudData() {
    closeOverflowMenuIfOpen();
    if (!confirm('Delete your cloud data permanently? Your local data will be kept.')) return;
    WanderSync.deleteAccount().then(() => {
        showSuccess('Cloud data deleted.');
    }).catch((err) => {
        console.warn('Delete cloud data failed', err);
        showError('Could not delete cloud data. Try again later.');
    });
}

// closeOverflowMenuIfOpen lives in overflow-menu.js (sole owner of the menu's
// open state); called here as a global after acting on a menu item.

function updateSyncMenu() {
    const s = WanderSync.getState();
    const status = document.getElementById('syncStatus');
    const usernameEl = document.getElementById('syncUsername');
    const enableBtn = document.getElementById('enableCloudBackupBtn');
    const copyLinkBtn = document.getElementById('copyBackupLinkBtn');
    const deleteBtn = document.getElementById('deleteCloudDataBtn');
    if (s.state === 'accepted') {
        status.style.display = '';
        usernameEl.textContent = s.username || '';
        enableBtn.style.display = 'none';
        copyLinkBtn.style.display = '';
        deleteBtn.style.display = '';
    } else {
        status.style.display = 'none';
        usernameEl.textContent = '';
        enableBtn.style.display = '';
        copyLinkBtn.style.display = 'none';
        deleteBtn.style.display = 'none';
    }
}

window.addEventListener('wander-sync-state-change', updateSyncMenu);

globalThis.showConsentToast = showConsentToast;
globalThis.enableCloudBackup = enableCloudBackup;
globalThis.copyBackupLink = copyBackupLink;
globalThis.confirmDeleteCloudData = confirmDeleteCloudData;
globalThis.updateSyncMenu = updateSyncMenu;
