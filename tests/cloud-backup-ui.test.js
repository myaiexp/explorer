/**
 * Tests for cloud-backup-ui.js — the consent toast and overflow-menu sync
 * controls (audit #7070).
 *
 * sync.test.js stubs showConsentToast, so Decline / the 30s auto-timer /
 * Accept success-and-failure / the duplicate-toast guard never ran against
 * the real DOM. This file drives the production UI with fake timers and the
 * real WanderSync (via the sync harness) so decline() actually persists
 * walk_cloud_backup state=declined.
 *
 * Collaborators resolved at call time: showError/showSuccess and
 * closeOverflowMenuIfOpen are faked (toast.js / overflow-menu.js have their
 * own suites). WanderSync is the real one so persist + getState().link
 * are the production paths.
 *
 * updateSyncMenu (finding #7587) is the only place that shows/hides Enable /
 * Copy backup link / Delete cloud data. Accept success already fires
 * wander-sync-state-change; these tests assert the resulting visibility so a
 * regression cannot leave the private #t= link uncopyable or Delete visible
 * while anonymous.
 */
import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import {
    installSyncLifecycle, mockFetch, setupAccepted,
} from './helpers/sync-harness.js';

installSyncLifecycle();

beforeAll(() => {
    loadScripts('cloud-backup-ui');
});

const errors = [];
const successes = [];

beforeEach(() => {
    errors.length = 0;
    successes.length = 0;
    // Match index.html: all three controls start hidden so a missed
    // updateSyncMenu cannot pass as "copy already visible".
    document.body.innerHTML =
        '<div id="syncStatus" style="display:none"><span id="syncUsername"></span></div>' +
        '<button id="enableCloudBackupBtn" style="display:none"></button>' +
        '<button id="copyBackupLinkBtn" style="display:none"></button>' +
        '<button id="deleteCloudDataBtn" style="display:none"></button>';
    globalThis.showError = (m) => errors.push(m);
    globalThis.showSuccess = (m) => successes.push(m);
    globalThis.closeOverflowMenuIfOpen = vi.fn();
    // harness deletes WanderSyncUI each test so the toast hook doesn't
    // intercept requestConsent in other suites; re-bind the real one.
    window.WanderSyncUI = { showConsentToast: globalThis.showConsentToast };
    vi.useFakeTimers();
});

function consentRecord() {
    const raw = localStorage.getItem('walk_cloud_backup');
    return raw ? JSON.parse(raw) : null;
}

function toastEl() {
    return document.getElementById('cloudConsentToast');
}

function button(label) {
    return [...toastEl().querySelectorAll('button')].find((b) => b.textContent === label);
}

function stubClipboard(writeText) {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
    });
}

function syncMenu() {
    const display = (id) => document.getElementById(id).style.display;
    return {
        status: display('syncStatus'),
        username: document.getElementById('syncUsername').textContent,
        enable: display('enableCloudBackupBtn'),
        copy: display('copyBackupLinkBtn'),
        del: display('deleteCloudDataBtn'),
    };
}

function expectAcceptedMenu(username) {
    expect(syncMenu()).toEqual({
        status: '', username, enable: 'none', copy: '', del: '',
    });
}

function expectAnonymousMenu() {
    expect(syncMenu()).toEqual({
        status: 'none', username: '', enable: '', copy: 'none', del: 'none',
    });
}

// ── showConsentToast ─────────────────────────────────────────────────────────

describe('showConsentToast', () => {
    test('load registers WanderSyncUI.showConsentToast', () => {
        expect(window.WanderSyncUI.showConsentToast).toBe(globalThis.showConsentToast);
    });

    test('second call while the toast is open resolves declined without a second node', async () => {
        const first = globalThis.showConsentToast();
        expect(document.querySelectorAll('#cloudConsentToast')).toHaveLength(1);
        await expect(globalThis.showConsentToast()).resolves.toBe('declined');
        expect(document.querySelectorAll('.toast-consent')).toHaveLength(1);
        expect(consentRecord()).toBeNull();
        // First toast still owns the session — Decline it so the timer doesn't leak.
        button('Decline').click();
        await expect(first).resolves.toBe('declined');
    });

    test('Decline calls WanderSync.decline() and persists declined', async () => {
        const decline = vi.spyOn(window.WanderSync, 'decline');
        const pending = globalThis.showConsentToast();
        button('Decline').click();
        await expect(pending).resolves.toBe('declined');
        expect(decline).toHaveBeenCalledTimes(1);
        expect(consentRecord()).toEqual({ state: 'declined' });
        expect(window.WanderSync.getState().state).toBe('declined');
        expect(toastEl()).toBeNull();
        expectAnonymousMenu();
    });

    test('30s auto-timer calls decline() and persists declined', async () => {
        const decline = vi.spyOn(window.WanderSync, 'decline');
        const pending = globalThis.showConsentToast();
        vi.advanceTimersByTime(29999);
        expect(toastEl()).not.toBeNull();
        expect(decline).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        await expect(pending).resolves.toBe('declined');
        expect(decline).toHaveBeenCalledTimes(1);
        expect(consentRecord()).toEqual({ state: 'declined' });
        expect(toastEl()).toBeNull();
    });

    test('Accept success settles accepted and does not persist declined', async () => {
        mockFetch({
            'POST /wander/api/accounts': { username: 'rugged-pine-42', token: 'tok-rp42' },
            'POST /wander/api/rugged-pine-42/import': { status: 204 },
        });
        const decline = vi.spyOn(window.WanderSync, 'decline');
        const pending = globalThis.showConsentToast();
        const acceptBtn = button('Accept');
        const declineBtn = button('Decline');
        acceptBtn.click();
        expect(acceptBtn.textContent).toBe('Saving…');
        expect(acceptBtn.disabled).toBe(true);
        expect(declineBtn.disabled).toBe(true);
        await expect(pending).resolves.toBe('accepted');
        expect(decline).not.toHaveBeenCalled();
        expect(consentRecord()).toMatchObject({
            state: 'accepted', username: 'rugged-pine-42', token: 'tok-rp42',
        });
        expect(successes).toEqual(['Cloud backup enabled.']);
        expect(toastEl()).toBeNull();
        expectAcceptedMenu('rugged-pine-42');

        // Timer must not fire decline() after a successful Accept.
        vi.advanceTimersByTime(30000);
        expect(decline).not.toHaveBeenCalled();
        expect(window.WanderSync.getState().state).toBe('accepted');
        expectAcceptedMenu('rugged-pine-42');
    });

    test('Accept failure settles declined without calling WanderSync.decline()', async () => {
        mockFetch({ 'POST /wander/api/accounts': { status: 500 } });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const decline = vi.spyOn(window.WanderSync, 'decline');
        const pending = globalThis.showConsentToast();
        button('Accept').click();
        await expect(pending).resolves.toBe('declined');
        expect(decline).not.toHaveBeenCalled();
        expect(consentRecord()).toBeNull();
        expect(window.WanderSync.getState().state).toBe('anonymous');
        expect(errors).toEqual(['Could not enable cloud backup. Try again later.']);
        expect(toastEl()).toBeNull();
        // Accept-failure never fires a state change (state stays anonymous),
        // so the menu stays at its initial hidden controls — copy/delete
        // must not appear just because the toast settled.
        expect(syncMenu().copy).toBe('none');
        expect(syncMenu().del).toBe('none');
    });

    test('timer does not decline() while Accept is in flight', async () => {
        let resolveAccept;
        const decline = vi.spyOn(window.WanderSync, 'decline');
        vi.spyOn(window.WanderSync, 'accept').mockImplementation(
            () => new Promise((resolve) => { resolveAccept = resolve; }),
        );
        const pending = globalThis.showConsentToast();
        const acceptBtn = button('Accept');
        acceptBtn.click();
        expect(acceptBtn.textContent).toBe('Saving…');
        await vi.advanceTimersByTimeAsync(30000);
        expect(decline).not.toHaveBeenCalled();
        expect(toastEl()).not.toBeNull();
        resolveAccept();
        await expect(pending).resolves.toBe('accepted');
        expect(successes).toEqual(['Cloud backup enabled.']);
        expect(consentRecord()).toBeNull(); // accept() was mocked, so no persist
    });
});

// ── copyBackupLink ───────────────────────────────────────────────────────────

describe('copyBackupLink', () => {
    test('with a link copies the secret-token URL', async () => {
        await setupAccepted('rugged-pine-42');
        const writeText = vi.fn(() => Promise.resolve());
        stubClipboard(writeText);
        globalThis.copyBackupLink();
        expect(globalThis.closeOverflowMenuIfOpen).toHaveBeenCalled();
        expect(writeText).toHaveBeenCalledWith(
            'https://mase.fi/wander/rugged-pine-42#t=tok-rugged-pine-42',
        );
        await writeText.mock.results[0].value;
        expect(successes).toEqual([
            'Backup link copied — open it on any device to restore your data.',
        ]);
    });

    test('without a link toasts an error and does not touch the clipboard', () => {
        const writeText = vi.fn();
        stubClipboard(writeText);
        globalThis.copyBackupLink();
        expect(globalThis.closeOverflowMenuIfOpen).toHaveBeenCalled();
        expect(writeText).not.toHaveBeenCalled();
        expect(errors).toEqual(['No backup link available.']);
    });

    test('clipboard rejection toasts a copy-failed error', async () => {
        await setupAccepted('rugged-pine-42');
        const writeText = vi.fn(() => Promise.reject(new Error('denied')));
        stubClipboard(writeText);
        globalThis.copyBackupLink();
        await writeText.mock.results[0].value.catch(() => {});
        expect(errors).toEqual(['Failed to copy link.']);
    });
});

// ── confirmDeleteCloudData ───────────────────────────────────────────────────

describe('confirmDeleteCloudData', () => {
    test('cancel leaves the account in place', async () => {
        await setupAccepted('rugged-pine-42');
        vi.spyOn(window, 'confirm').mockReturnValue(false);
        const del = vi.spyOn(window.WanderSync, 'deleteAccount');
        globalThis.confirmDeleteCloudData();
        expect(globalThis.closeOverflowMenuIfOpen).toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
        expect(window.WanderSync.getState().state).toBe('accepted');
    });

    test('confirm calls deleteAccount and toasts success', async () => {
        await setupAccepted('rugged-pine-42');
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        mockFetch({ 'DELETE /wander/api/rugged-pine-42': { status: 204 } });
        const del = vi.spyOn(window.WanderSync, 'deleteAccount');
        globalThis.confirmDeleteCloudData();
        expect(del).toHaveBeenCalledTimes(1);
        await del.mock.results[0].value;
        expect(window.WanderSync.getState().state).toBe('anonymous');
        expect(consentRecord()).toBeNull();
        expect(successes).toEqual(['Cloud data deleted.']);
        expectAnonymousMenu();
    });
});

// ── updateSyncMenu ───────────────────────────────────────────────────────────

describe('updateSyncMenu', () => {
    function stubState(state, username = null) {
        vi.spyOn(window.WanderSync, 'getState').mockReturnValue({
            state, username, token: null, link: null,
        });
    }

    test('accepted shows copy-link and delete, hides enable, paints username', () => {
        stubState('accepted', 'rugged-pine-42');
        updateSyncMenu();
        expectAcceptedMenu('rugged-pine-42');
    });

    test.each(['anonymous', 'declined'])(
        '%s hides copy-link and delete, shows enable, clears username',
        (state) => {
            stubState(state, 'stale-user');
            updateSyncMenu();
            expectAnonymousMenu();
        },
    );
});
