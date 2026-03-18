/**
 * Popup entry point — initialization and orchestration.
 */
document.addEventListener('DOMContentLoaded', async () => {
    // Bind event listeners
    document.getElementById('refresh-btn').addEventListener('click', refresh);
    document.getElementById('settings-btn').addEventListener('click', toggleSettings);
    document.getElementById('save-url-btn').addEventListener('click', saveUrl);
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    document.getElementById('stop-tomcat-btn').addEventListener('click', stopTomcat);
    document.getElementById('restart-tomcat-btn').addEventListener('click', restartTomcat);
    document.getElementById('restart-all-agents-btn').addEventListener('click', restartAllAgents);
    document.getElementById('free-ram-btn').addEventListener('click', freeRam);
    document.getElementById('clear-swap-btn').addEventListener('click', clearSwap);
    document.getElementById('restart-server-btn').addEventListener('click', restartServer);
    document.getElementById('logs-tomcat-btn').addEventListener('click', () => openLogViewer('tomcat'));
    document.getElementById('log-close-btn').addEventListener('click', closeLogViewer);
    document.getElementById('log-modal-backdrop').addEventListener('click', closeLogViewer);
    document.getElementById('log-refresh-btn').addEventListener('click', refreshLogViewer);
    document.getElementById('log-lines-select').addEventListener('change', refreshLogViewer);
    document.getElementById('pull-btn').addEventListener('click', startPull);
    document.getElementById('deploy-btn').addEventListener('click', startDeploy);
    document.getElementById('quick-deploy-btn').addEventListener('click', startQuickDeploy);
    document.getElementById('stash-btn').addEventListener('click', stashChanges);
    setupTypeahead();

    // Apply saved theme
    await applyTheme();

    // Load saved URL into input
    const baseUrl = await ApiClient.getBaseUrl();
    document.getElementById('server-url-input').value = baseUrl;

    // Fetch server name from config
    loadServerName();

    await PendingAgents.load();
    await loadBranches();
    await checkDeployStatus();
    await loadAndRender();
    resumePendingPolls();
});

async function loadServerName() {
    try {
        const cfg = await ApiClient.getClientConfig();
        if (cfg.name) {
            document.getElementById('server-name').textContent = cfg.name;
        }
    } catch { /* keep default */ }
}

async function loadAndRender() {
    const stored = await AppStorage.get([
        StorageKeys.LAST_STATUS, StorageKeys.LAST_CHECK,
        StorageKeys.HEALTHY, StorageKeys.ERROR,
    ]);
    if (stored[StorageKeys.ERROR] && !stored[StorageKeys.LAST_STATUS]) {
        showError(stored[StorageKeys.ERROR]);
        return;
    }
    if (stored[StorageKeys.LAST_STATUS]) {
        if (PendingAgents.size() > 0) {
            const changed = PendingAgents.reconcile(stored[StorageKeys.LAST_STATUS]);
            if (changed) await PendingAgents.save();
        }
        render(stored[StorageKeys.LAST_STATUS], stored[StorageKeys.LAST_CHECK]);
    } else {
        showError('No data yet — click refresh');
    }
}

async function refresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    hideError();
    try {
        const data = await ApiClient.getStatus();
        if (PendingAgents.size() > 0) {
            const changed = PendingAgents.reconcile(data);
            if (changed) await PendingAgents.save();
        }
        const now = Date.now();
        await AppStorage.set({
            [StorageKeys.LAST_STATUS]: data,
            [StorageKeys.LAST_CHECK]: now,
            [StorageKeys.ERROR]: null,
        });
        render(data, now);
    } catch (e) {
        showError('Cannot reach status API: ' + e.message);
    } finally {
        btn.classList.remove('spinning');
    }
    chrome.runtime.sendMessage({ action: 'refresh' }).catch(() => {});
}

function render(data, lastCheck) {
    if (lastCheck) {
        const ago = Math.round((Date.now() - lastCheck) / 1000);
        document.getElementById('last-check').textContent =
            ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    }

    renderSystemStats(data.system);
    renderAppServer(data.tomcat);
    renderProcesses(data.agents);
}
