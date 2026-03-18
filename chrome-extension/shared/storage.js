/**
 * Unified chrome.storage helper.
 * Used by both popup and background service worker.
 */
const StorageKeys = {
    SERVER_URL: 'serverUrl',
    THEME: 'theme',
    LAST_STATUS: 'lastStatus',
    LAST_CHECK: 'lastCheck',
    HEALTHY: 'healthy',
    ERROR: 'error',
    MANUALLY_STARTED: 'manuallyStarted',
    MANUALLY_STOPPED: 'manuallyStopped',
    PENDING_RESTARTS: 'pendingRestarts',
};

const AppStorage = (() => {
    async function get(keys) {
        return chrome.storage.local.get(keys);
    }

    async function set(data) {
        return chrome.storage.local.set(data);
    }

    async function remove(keys) {
        return chrome.storage.local.remove(keys);
    }

    async function clearCachedData() {
        return remove([StorageKeys.LAST_STATUS, StorageKeys.LAST_CHECK, StorageKeys.ERROR]);
    }

    return { get, set, remove, clearCachedData };
})();
