const DEFAULT_URL = 'http://localhost:7103';

// Track previous state to only notify on NEW problems
let prevHealthy = true;
let prevProblems = [];

async function getApiUrl() {
    const { serverUrl } = await chrome.storage.local.get('serverUrl');
    return serverUrl || DEFAULT_URL;
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create('checkStatus', { periodInMinutes: 1 });
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

        // Only monitor agents that should be running:
        // - autostart enabled, unless manually stopped
        // - manually started via the extension
        const { manuallyStarted = [], manuallyStopped = [] } = await chrome.storage.local.get(['manuallyStarted', 'manuallyStopped']);
        const monitored = (data.agents.agents || []).filter(a => {
            if (manuallyStopped.includes(a.name)) return false;
            if (a.autostart === true) return true;
            if (manuallyStarted.includes(a.name)) return true;
            return false;
        });
        const monitoredHealthy = monitored.filter(a => a.running && a.accessible).length;
        const monitoredTotal = monitored.length;
        const agentsOk = monitoredHealthy === monitoredTotal;

        const tomcatOk = data.tomcat.running;
        const tomcatReady = data.tomcat.ready;
        const memPct = data.system.memory.used / data.system.memory.total;
        const systemOk = memPct < 0.95;

        const allOk = agentsOk && tomcatOk && tomcatReady && systemOk;

        // Build list of current problems
        const problems = [];
        if (!tomcatOk) problems.push('Tomcat is down');
        else if (!tomcatReady) problems.push('Tomcat is starting (platform not ready)');
        if (!systemOk) problems.push(`RAM at ${(memPct * 100).toFixed(0)}%`);
        const downAgents = monitored.filter(a => !a.running || !a.accessible);
        for (const a of downAgents) {
            problems.push(`${a.name} is ${a.running ? 'not accessible' : 'stopped'}`);
        }

        // Notify only on transition from healthy to unhealthy, or new problems
        if (!allOk && (prevHealthy || hasNewProblems(problems, prevProblems))) {
            notify(problems);
        }
        // Notify recovery
        if (allOk && !prevHealthy) {
            chrome.notifications.create('gw-recovery', {
                type: 'basic',
                iconUrl: 'icons/icon-green-128.png',
                title: 'GeoWealth Server — Recovered',
                message: `All systems OK — ${monitoredHealthy}/${monitoredTotal} agents healthy`,
                priority: 1,
            });
        }

        prevHealthy = allOk;
        prevProblems = problems;

        await chrome.storage.local.set({
            lastStatus: data,
            lastCheck: Date.now(),
            healthy: allOk,
            error: null,
        });

        const downNames = downAgents.map(a => a.name);
        updateBadge(allOk, monitoredHealthy, monitoredTotal, false, downNames);
    } catch (e) {
        // Notify server unreachable (only on transition)
        if (prevHealthy) {
            chrome.notifications.create('gw-unreachable', {
                type: 'basic',
                iconUrl: 'icons/icon-red-128.png',
                title: 'GeoWealth Server — Unreachable',
                message: 'Cannot reach status API: ' + e.message,
                priority: 2,
            });
        }
        prevHealthy = false;
        prevProblems = ['Server unreachable'];

        await chrome.storage.local.set({
            lastCheck: Date.now(),
            healthy: false,
            error: e.message,
        });
        updateBadge(false, 0, 0, true);
    }
}

function hasNewProblems(current, previous) {
    return current.some(p => !previous.includes(p));
}

function notify(problems) {
    const count = problems.length;
    const message = problems.slice(0, 4).join('\n') + (count > 4 ? `\n... and ${count - 4} more` : '');
    chrome.notifications.create('gw-alert-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon-red-128.png',
        title: `GeoWealth Server — ${count} problem${count > 1 ? 's' : ''}`,
        message,
        priority: 2,
    });
}

function updateBadge(allOk, healthy, total, unreachable = false, downNames = []) {
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
        const names = downNames.length ? '\n⬇ ' + downNames.join(', ') : '';
        chrome.action.setTitle({ title: `Issues — ${healthy}/${total} agents healthy${names}` });
    }
}

// Open in new tab when extension icon is clicked
chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'refresh') {
        checkStatus().then(() => sendResponse({ ok: true }));
        return true;
    }
    if (msg.action === 'agentStarted') {
        trackManualStart(msg.name).then(() => sendResponse({ ok: true }));
        return true;
    }
    if (msg.action === 'agentStopped') {
        trackManualStop(msg.name).then(() => sendResponse({ ok: true }));
        return true;
    }
});

async function trackManualStart(name) {
    const { manuallyStarted = [], manuallyStopped = [] } = await chrome.storage.local.get(['manuallyStarted', 'manuallyStopped']);
    await chrome.storage.local.set({
        manuallyStarted: manuallyStarted.includes(name) ? manuallyStarted : [...manuallyStarted, name],
        manuallyStopped: manuallyStopped.filter(n => n !== name),
    });
}

async function trackManualStop(name) {
    const { manuallyStarted = [], manuallyStopped = [] } = await chrome.storage.local.get(['manuallyStarted', 'manuallyStopped']);
    await chrome.storage.local.set({
        manuallyStarted: manuallyStarted.filter(n => n !== name),
        manuallyStopped: manuallyStopped.includes(name) ? manuallyStopped : [...manuallyStopped, name],
    });
}
