const DEFAULT_URL = 'http://localhost:7103';

async function getApiUrl() {
    const { serverUrl } = await chrome.storage.local.get('serverUrl');
    return serverUrl || DEFAULT_URL;
}

document.addEventListener('DOMContentLoaded', async () => {

    document.getElementById('refresh-btn').addEventListener('click', refresh);
    document.getElementById('settings-btn').addEventListener('click', toggleSettings);
    document.getElementById('save-url-btn').addEventListener('click', saveUrl);
    document.getElementById('theme-btn').addEventListener('click', toggleTheme);
    document.getElementById('restart-tomcat-btn').addEventListener('click', restartTomcat);
    document.getElementById('restart-all-agents-btn').addEventListener('click', restartAllAgents);
    document.getElementById('logs-tomcat-btn').addEventListener('click', () => openLogViewer('tomcat'));
    document.getElementById('log-close-btn').addEventListener('click', closeLogViewer);
    document.getElementById('log-modal-backdrop').addEventListener('click', closeLogViewer);
    document.getElementById('log-refresh-btn').addEventListener('click', refreshLogViewer);
    document.getElementById('log-lines-select').addEventListener('change', refreshLogViewer);

    // Apply saved theme
    await applyTheme();

    // Load saved URL into input
    const url = await getApiUrl();
    document.getElementById('server-url-input').value = url;

    await loadAndRender();
});

async function applyTheme() {
    const { theme } = await chrome.storage.local.get('theme');
    const btn = document.getElementById('theme-btn');
    if (theme) {
        document.documentElement.setAttribute('data-theme', theme);
        btn.textContent = theme === 'dark' ? '\u2600' : '\u263E';
    } else {
        // Auto — follow system preference
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        btn.textContent = prefersDark ? '\u2600' : '\u263E';
    }
}

async function toggleTheme() {
    const { theme } = await chrome.storage.local.get('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    let next;
    if (!theme) {
        // Auto mode → switch to opposite of system
        next = prefersDark ? 'light' : 'dark';
    } else if (theme === 'dark') {
        next = 'light';
    } else {
        next = 'dark';
    }

    await chrome.storage.local.set({ theme: next });
    document.documentElement.setAttribute('data-theme', next);
    document.getElementById('theme-btn').textContent = next === 'dark' ? '\u2600' : '\u263E';
}

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
    const proc = tom.process || {};
    const threads = tom.threads || {};
    const jvm = tom.jvm || {};

    document.getElementById('tomcat-status').innerHTML =
        `<span class="dot ${tomOk ? 'green' : 'red'}"></span>${tomOk ? 'Running' : 'Down'} :${tom.http_port}`;
    document.getElementById('tomcat-response').textContent =
        tomOk ? `${tom.response_ms}ms` : `HTTP ${tom.http_code}`;
    document.getElementById('tomcat-uptime').textContent =
        proc.uptime_seconds ? formatUptime(proc.uptime_seconds) : '-';
    document.getElementById('tomcat-requests').textContent =
        tom.requests_today != null ? tom.requests_today.toLocaleString() : '-';

    // Memory bar — RSS vs Xmx
    const rssBytes = (proc.rss_kb || 0) * 1024;
    const xmxBytes = parseXmx(proc.xmx);
    if (xmxBytes > 0) {
        setBar('tomcat-mem', rssBytes, xmxBytes,
            `${formatBytes(rssBytes)} / ${formatBytes(xmxBytes)}`);
    } else {
        document.getElementById('tomcat-mem-text').textContent =
            rssBytes ? formatBytes(rssBytes) : '-';
    }

    document.getElementById('tomcat-cpu').textContent =
        proc.cpu_pct != null ? `${proc.cpu_pct.toFixed(1)}%` : '-';
    document.getElementById('tomcat-threads').textContent =
        threads.count ? `${threads.count}` : '-';
    document.getElementById('tomcat-fds').textContent =
        threads.open_fds ? `${threads.open_fds} / ${threads.fd_limit.toLocaleString()}` : '-';

    const jvmParts = [];
    if (jvm.xmx) jvmParts.push(`Xmx ${jvm.xmx}`);
    if (jvm.max_direct_memory) jvmParts.push(`Direct ${jvm.max_direct_memory}`);
    if (jvm.gc_type) jvmParts.push(`GC: ${jvm.gc_type}`);
    if (jvm.reactor_pool_size) jvmParts.push(`Reactor: ${jvm.reactor_pool_size}`);
    if (jvm.akka_system) jvmParts.push(`Akka: ${jvm.akka_system}`);
    if (jvm.dev_mode) jvmParts.push('DEV');
    document.getElementById('tomcat-jvm').textContent = jvmParts.join(' · ') || '-';

    const webapps = tom.webapps || [];
    document.getElementById('tomcat-webapps').textContent =
        webapps.length ? webapps.join(', ') : '-';

    document.getElementById('agent-summary').textContent =
        `(${ag.running}/${ag.total} running, ${ag.healthy} healthy)`;

    const tbody = document.getElementById('agents-tbody');
    tbody.innerHTML = '';
    // Sort: running first, then by name
    const sorted = [...ag.agents].sort((a, b) => {
        if (a.running !== b.running) return a.running ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    for (const a of sorted) {
        const tr = document.createElement('tr');
        if (!a.running) tr.classList.add('agent-stopped');

        const rssBytes = (a.rss_kb || 0) * 1024;
        const xmxBytes = parseXmx(a.xmx);
        const memPct = xmxBytes > 0 ? ((rssBytes / xmxBytes) * 100).toFixed(0) : 0;
        const memBarClass = memPct > 90 ? 'danger' : memPct > 75 ? 'warn' : '';
        const memText = a.running && xmxBytes > 0
            ? `${formatBytes(rssBytes)} / ${a.xmx}`
            : (a.running && rssBytes ? formatBytes(rssBytes) : '-');

        const configMem = a.configured_memory != null ? `${a.configured_memory}g` : '-';
        const autoChecked = a.autostart !== false ? 'checked' : '';
        const autoToggle = a.configured_memory != null
            ? `<label class="autostart-toggle" title="Autostart"><input type="checkbox" class="autostart-cb" data-agent="${escapeHtml(a.name)}" ${autoChecked}><span class="toggle-slider"></span></label>`
            : '';

        let statusHtml;
        if (a.running) {
            statusHtml = `<span class="dot ${a.accessible ? 'green' : 'red'}"></span>${a.accessible ? 'OK' : 'DOWN'}`;
        } else {
            statusHtml = '<span class="dot gray"></span>Stopped';
        }

        tr.innerHTML = `
            <td><strong>${escapeHtml(a.name)}</strong> ${autoToggle}</td>
            <td class="config-cell">
              <span class="config-mem">${configMem}</span>
              <button class="edit-mem-btn" data-agent="${escapeHtml(a.name)}" data-current="${a.configured_memory || ''}" title="Edit memory">&#x270E;</button>
            </td>
            <td class="mem-cell">
              ${a.running ? `<div class="bar-wrap"><div class="bar ${memBarClass}" style="width:${memPct}%"></div></div>` : ''}
              <span class="mem-label">${memText}</span>
            </td>
            <td>${a.running && a.cpu_pct != null ? a.cpu_pct.toFixed(1) + '%' : '-'}</td>
            <td>${a.running && a.threads ? a.threads : '-'}</td>
            <td>${a.running && a.open_fds ? a.open_fds : '-'}</td>
            <td>${a.running && a.uptime_seconds ? formatUptime(a.uptime_seconds) : '-'}</td>
            <td>${statusHtml}</td>
            <td>${a.running ? `<button class="log-agent-btn log-btn-sm" data-agent="${escapeHtml(a.name)}" title="View logs">&#x1F4C4;</button>` : ''}</td>
            <td><button class="restart-agent-btn restart-btn-sm" data-agent="${escapeHtml(a.name)}" title="${a.running ? 'Restart' : 'Start'} ${escapeHtml(a.name)}">&#x21bb;</button></td>
        `;
        tbody.appendChild(tr);
    }

    // Bind agent buttons
    document.querySelectorAll('.restart-agent-btn').forEach(btn => {
        btn.addEventListener('click', () => restartAgent(btn.dataset.agent, btn));
    });
    document.querySelectorAll('.log-agent-btn').forEach(btn => {
        btn.addEventListener('click', () => openLogViewer('agent', btn.dataset.agent));
    });
    document.querySelectorAll('.edit-mem-btn').forEach(btn => {
        btn.addEventListener('click', () => editAgentMemory(btn.dataset.agent, btn.dataset.current));
    });
    document.querySelectorAll('.autostart-cb').forEach(cb => {
        cb.addEventListener('change', () => toggleAutostart(cb.dataset.agent, cb.checked, cb));
    });
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

function parseXmx(val) {
    if (!val) return 0;
    const m = val.match(/^(\d+(?:\.\d+)?)\s*([gmk])?$/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'g') return num * 1e9;
    if (unit === 'm') return num * 1e6;
    if (unit === 'k') return num * 1e3;
    return num;
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

// ── Log viewer ──

let currentLogType = null;
let currentLogName = null;

async function openLogViewer(type, name) {
    currentLogType = type;
    currentLogName = name;
    const title = type === 'tomcat' ? 'Tomcat — catalina.out' : `Agent — ${name}/stdout.log`;
    document.getElementById('log-modal-title').textContent = title;
    document.getElementById('log-modal').classList.remove('hidden');
    await fetchLogs();
}

function closeLogViewer() {
    document.getElementById('log-modal').classList.add('hidden');
    currentLogType = null;
    currentLogName = null;
}

async function refreshLogViewer() {
    if (currentLogType) await fetchLogs();
}

async function fetchLogs() {
    const body = document.getElementById('log-modal-body');
    body.textContent = 'Loading...';
    const baseUrl = await getApiUrl();
    const lines = document.getElementById('log-lines-select').value;
    const path = currentLogType === 'tomcat'
        ? `${baseUrl}/logs/tomcat?lines=${lines}`
        : `${baseUrl}/logs/agent/${currentLogName}?lines=${lines}`;
    try {
        const res = await fetch(path, { signal: AbortSignal.timeout(15000) });
        body.textContent = await res.text();
        body.scrollTop = body.scrollHeight;
    } catch (e) {
        body.textContent = 'Error fetching logs: ' + e.message;
    }
}

// ── Config functions ──

async function editAgentMemory(name, current) {
    const newMem = prompt(`Set max memory (GB) for "${name}":`, current || '4');
    if (newMem === null) return;
    const val = parseInt(newMem, 10);
    if (!val || val < 1 || val > 64) {
        return showError('Memory must be between 1 and 64 GB');
    }
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/config/agent/${name}/memory`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memory: val }),
        });
        const data = await res.json();
        if (data.ok) {
            await refresh();
        } else {
            showError(data.message);
        }
    } catch (e) {
        showError('Failed to update memory: ' + e.message);
    }
}

async function toggleAutostart(name, enabled, cb) {
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/config/agent/${name}/autostart`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        const data = await res.json();
        if (!data.ok) {
            cb.checked = !enabled; // revert
            showError(data.message);
        }
    } catch (e) {
        cb.checked = !enabled; // revert
        showError('Failed to update autostart: ' + e.message);
    }
}

// ── Restart functions ──

async function restartTomcat() {
    if (!confirm('Are you sure you want to restart Tomcat?')) return;
    const btn = document.getElementById('restart-tomcat-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Restarting...';
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/restart/tomcat`, {
            method: 'POST',
            signal: AbortSignal.timeout(120000),
        });
        const data = await res.json();
        btn.textContent = data.ok ? '✓ Done' : '✗ Failed';
        if (!data.ok) showError('Tomcat restart failed: ' + data.message);
    } catch (e) {
        btn.textContent = '✗ Error';
        showError('Tomcat restart error: ' + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x21bb; Restart';
        refresh();
    }, 3000);
}

async function restartAgent(name, btn) {
    if (!confirm(`Restart agent "${name}"?`)) return;
    btn.disabled = true;
    btn.textContent = '⏳';
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/restart/agent/${name}`, {
            method: 'POST',
            signal: AbortSignal.timeout(120000),
        });
        const data = await res.json();
        btn.textContent = data.ok ? '✓' : '✗';
        if (!data.ok) showError(`Agent "${name}" restart failed: ` + data.message);
    } catch (e) {
        btn.textContent = '✗';
        showError(`Agent "${name}" restart error: ` + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x21bb;';
        refresh();
    }, 3000);
}

async function restartAllAgents() {
    if (!confirm('Restart ALL agents? This may take several minutes.')) return;
    const btn = document.getElementById('restart-all-agents-btn');
    btn.disabled = true;
    btn.textContent = '⏳ Restarting...';
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/restart/agents`, {
            method: 'POST',
            signal: AbortSignal.timeout(300000),
        });
        const data = await res.json();
        btn.textContent = data.ok ? '✓ Done' : '✗ Failed';
        if (!data.ok) showError('Agents restart failed: ' + data.message);
    } catch (e) {
        btn.textContent = '✗ Error';
        showError('Agents restart error: ' + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x21bb; Restart All';
        refresh();
    }, 5000);
}

function showError(msg) {
    document.getElementById('error-banner').classList.remove('hidden');
    document.getElementById('error-msg').textContent = msg;
}

function hideError() {
    document.getElementById('error-banner').classList.add('hidden');
}
