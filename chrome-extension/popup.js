const DEFAULT_URL = 'http://localhost:7103';

async function getApiUrl() {
    const { serverUrl } = await chrome.storage.local.get('serverUrl');
    return serverUrl || DEFAULT_URL;
}

document.addEventListener('DOMContentLoaded', async () => {
    document.getElementById('refresh-btn').addEventListener('click', refresh);
    document.getElementById('settings-btn').addEventListener('click', toggleSettings);
    document.getElementById('save-url-btn').addEventListener('click', saveUrl);

    // Load saved URL into input
    const url = await getApiUrl();
    document.getElementById('server-url-input').value = url;

    await loadAndRender();
});

function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.classList.toggle('hidden');
    document.getElementById('settings-msg').classList.add('hidden');
}

async function saveUrl() {
    const input = document.getElementById('server-url-input');
    let url = input.value.trim();
    if (!url) url = DEFAULT_URL;
    // Remove trailing slash
    url = url.replace(/\/+$/, '');
    input.value = url;

    await chrome.storage.local.set({ serverUrl: url });

    const msg = document.getElementById('settings-msg');
    msg.textContent = 'Saved! Refreshing...';
    msg.className = 'settings-msg-ok';
    msg.classList.remove('hidden');

    // Clear old data and refresh
    await chrome.storage.local.remove(['lastStatus', 'lastCheck', 'error']);
    await refresh();

    setTimeout(() => {
        document.getElementById('settings-panel').classList.add('hidden');
    }, 800);
}

async function loadAndRender() {
    const stored = await chrome.storage.local.get(['lastStatus', 'lastCheck', 'healthy', 'error']);
    if (stored.error && !stored.lastStatus) {
        showError(stored.error);
        return;
    }
    if (stored.lastStatus) {
        render(stored.lastStatus, stored.lastCheck);
    } else {
        showError('No data yet — click refresh');
    }
}

async function refresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');
    hideError();
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        const agentsOk = data.agents.healthy === data.agents.total;
        const tomcatOk = data.tomcat.running;
        const now = Date.now();
        await chrome.storage.local.set({
            lastStatus: data, lastCheck: now,
            healthy: agentsOk && tomcatOk, error: null,
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
    const sys = data.system;
    const tom = data.tomcat;
    const ag = data.agents;

    if (lastCheck) {
        const ago = Math.round((Date.now() - lastCheck) / 1000);
        document.getElementById('last-check').textContent =
            ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
    }

    document.getElementById('uptime').textContent = formatUptime(sys.uptime_seconds);
    document.getElementById('load').textContent =
        sys.load_average.map(l => l.toFixed(2)).join(' / ') + ` (${sys.cpus} cores)`;

    setBar('ram', sys.memory.used, sys.memory.total,
        `${formatBytes(sys.memory.used)} / ${formatBytes(sys.memory.total)}`);
    setBar('swap', sys.memory.swap_used, sys.memory.swap_total,
        `${formatBytes(sys.memory.swap_used)} / ${formatBytes(sys.memory.swap_total)}`);
    setBar('disk', sys.disk.used, sys.disk.total,
        `${formatBytes(sys.disk.used)} / ${formatBytes(sys.disk.total)} (${sys.disk.use_pct})`);

    const tomOk = tom.running;
    document.getElementById('tomcat-status').innerHTML =
        `<span class="dot ${tomOk ? 'green' : 'red'}"></span>${tomOk ? 'Running' : 'Down'} :${tom.http_port}`;
    document.getElementById('tomcat-response').textContent =
        tomOk ? `${tom.response_ms}ms` : `HTTP ${tom.http_code}`;
    const proc = tom.process || {};
    document.getElementById('tomcat-mem').textContent =
        proc.xmx ? `Xmx ${proc.xmx} | RSS ${formatBytes((proc.rss_kb || 0) * 1024)}` : '';

    document.getElementById('agent-summary').textContent =
        `(${ag.healthy}/${ag.total} healthy)`;

    const tbody = document.getElementById('agents-tbody');
    tbody.innerHTML = '';
    const sorted = [...ag.agents].sort((a, b) => a.name.localeCompare(b.name));
    for (const a of sorted) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${escapeHtml(a.name)}</strong></td>
            <td>${escapeHtml(a.xmx || '-')}</td>
            <td>${a.rss_kb ? formatBytes(a.rss_kb * 1024) : '-'}</td>
            <td>${a.cpu_pct != null ? a.cpu_pct.toFixed(1) + '%' : '-'}</td>
            <td><span class="dot ${a.accessible ? 'green' : 'red'}"></span>${a.accessible ? 'OK' : 'DOWN'}</td>
        `;
        tbody.appendChild(tr);
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function setBar(id, used, total, text) {
    const pct = total > 0 ? (used / total) * 100 : 0;
    const bar = document.getElementById(`${id}-bar`);
    bar.style.width = pct + '%';
    bar.className = 'bar' + (pct > 90 ? ' danger' : pct > 75 ? ' warn' : '');
    document.getElementById(`${id}-text`).textContent = text;
}

function formatBytes(bytes) {
    if (bytes < 1e9) return (bytes / 1e6).toFixed(0) + ' MB';
    return (bytes / 1e9).toFixed(1) + ' GB';
}

function formatUptime(secs) {
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    let parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

function showError(msg) {
    document.getElementById('error-banner').classList.remove('hidden');
    document.getElementById('error-msg').textContent = msg;
}

function hideError() {
    document.getElementById('error-banner').classList.add('hidden');
}
