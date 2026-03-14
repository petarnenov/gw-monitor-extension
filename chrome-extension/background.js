const DEFAULT_URL = 'http://localhost:7103';
const CHECK_INTERVAL_MINUTES = 2;

async function getApiUrl() {
    const { serverUrl } = await chrome.storage.local.get('serverUrl');
    return serverUrl || DEFAULT_URL;
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('checkStatus', { periodInMinutes: CHECK_INTERVAL_MINUTES });
    checkStatus();
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'checkStatus') {
        checkStatus();
    }
});

async function checkStatus() {
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();

        const agentsOk = data.agents.healthy === data.agents.total;
        const tomcatOk = data.tomcat.running;
        const memPct = data.system.memory.used / data.system.memory.total;
        const systemOk = memPct < 0.95;

        const allOk = agentsOk && tomcatOk && systemOk;

        await chrome.storage.local.set({
            lastStatus: data,
            lastCheck: Date.now(),
            healthy: allOk,
            error: null,
        });

        updateBadge(allOk, data.agents.healthy, data.agents.total);
    } catch (e) {
        await chrome.storage.local.set({
            lastCheck: Date.now(),
            healthy: false,
            error: e.message,
        });
        updateBadge(false, 0, 0, true);
    }
}

function updateBadge(allOk, healthy, total, unreachable = false) {
    if (unreachable) {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#6B7280' });
        chrome.action.setTitle({ title: 'Server unreachable' });
    } else if (allOk) {
        chrome.action.setBadgeText({ text: '' });
        chrome.action.setTitle({ title: `All OK — ${healthy}/${total} agents` });
    } else {
        chrome.action.setBadgeText({ text: `${healthy}` });
        chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
        chrome.action.setTitle({ title: `Issues — ${healthy}/${total} agents healthy` });
    }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'refresh') {
        checkStatus().then(() => sendResponse({ ok: true }));
        return true;
    }
});
