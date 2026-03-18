/**
 * Settings panel — server URL configuration.
 */
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.toggle('hidden');
    document.getElementById('settings-msg').classList.add('hidden');
}

async function saveUrl() {
    const input = document.getElementById('server-url-input');
    let url = input.value.trim();
    if (!url) url = ApiClient.DEFAULT_URL;
    url = url.replace(/\/+$/, '');
    input.value = url;

    await AppStorage.set({ [StorageKeys.SERVER_URL]: url });

    const msg = document.getElementById('settings-msg');
    msg.textContent = 'Saved! Refreshing...';
    msg.className = 'settings-msg-ok';
    msg.classList.remove('hidden');

    await AppStorage.clearCachedData();
    await refresh();

    setTimeout(() => {
        document.getElementById('settings-panel').classList.add('hidden');
    }, 800);
}
