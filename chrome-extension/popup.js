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
    document.getElementById('deploy-btn').addEventListener('click', startDeploy);
    document.getElementById('stash-btn').addEventListener('click', stashChanges);
    setupTypeahead();

    // Apply saved theme
    await applyTheme();

    // Load saved URL into input
    const url = await getApiUrl();
    document.getElementById('server-url-input').value = url;

    await loadBranches();
    await checkDeployStatus();
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
    for (let idx = 0; idx < sorted.length; idx++) {
        const a = sorted[idx];
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
            <td class="row-num">${idx + 1}</td>
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
            <td class="action-btns">
              ${a.running ? `<button class="stop-agent-btn stop-btn-sm" data-agent="${escapeHtml(a.name)}" title="Stop ${escapeHtml(a.name)}">&#x25A0;</button>` : ''}
              <button class="restart-agent-btn restart-btn-sm" data-agent="${escapeHtml(a.name)}" title="${a.running ? 'Restart' : 'Start'} ${escapeHtml(a.name)}">&#x21bb;</button>
            </td>
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
    document.querySelectorAll('.stop-agent-btn').forEach(btn => {
        btn.addEventListener('click', () => stopAgent(btn.dataset.agent, btn));
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

// ── Deploy ──

let allBranches = [];
let selectedBranch = '';
let gitDirty = false;

async function loadBranches() {
    const baseUrl = await getApiUrl();
    try {
        const [brRes, stRes] = await Promise.all([
            fetch(`${baseUrl}/git/branches`, { signal: AbortSignal.timeout(30000) }),
            fetch(`${baseUrl}/git/status`, { signal: AbortSignal.timeout(10000) }),
        ]);
        const brData = await brRes.json();
        const stData = await stRes.json();

        allBranches = brData.branches;
        selectedBranch = brData.current;
        document.getElementById('branch-input').value = brData.current;
        document.getElementById('deploy-current').textContent = `Current: ${brData.current}`;

        updateDirtyState(stData.dirty, stData.changes);
    } catch {
        document.getElementById('deploy-current').textContent = 'Failed to load branches';
    }
}

function updateDirtyState(dirty, changes) {
    gitDirty = dirty;
    const dirtyEl = document.getElementById('deploy-dirty');
    const stashBtn = document.getElementById('stash-btn');
    const deployBtn = document.getElementById('deploy-btn');

    if (dirty) {
        dirtyEl.textContent = `${changes} uncommitted change${changes > 1 ? 's' : ''} — stash before deploy`;
        dirtyEl.classList.remove('hidden');
        stashBtn.classList.remove('hidden');
        deployBtn.disabled = true;
    } else {
        dirtyEl.classList.add('hidden');
        stashBtn.classList.add('hidden');
        deployBtn.disabled = !selectedBranch;
    }
}

function setupTypeahead() {
    const input = document.getElementById('branch-input');
    const dropdown = document.getElementById('branch-dropdown');

    input.addEventListener('focus', () => showDropdown(input.value));
    input.addEventListener('input', () => showDropdown(input.value));

    input.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.branch-item');
        const active = dropdown.querySelector('.branch-item.active');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!active && items.length) items[0].classList.add('active');
            else if (active && active.nextElementSibling) {
                active.classList.remove('active');
                active.nextElementSibling.classList.add('active');
                active.nextElementSibling.scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (active && active.previousElementSibling) {
                active.classList.remove('active');
                active.previousElementSibling.classList.add('active');
                active.previousElementSibling.scrollIntoView({ block: 'nearest' });
            }
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (active) selectBranch(active.dataset.branch);
            else if (items.length) selectBranch(items[0].dataset.branch);
            dropdown.classList.add('hidden');
        } else if (e.key === 'Escape') {
            dropdown.classList.add('hidden');
        }
    });

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.typeahead-wrap')) dropdown.classList.add('hidden');
    });
}

function showDropdown(query) {
    const dropdown = document.getElementById('branch-dropdown');
    const q = query.toLowerCase().trim();
    const filtered = q
        ? allBranches.filter(b => b.name.toLowerCase().includes(q))
        : allBranches;
    const limited = filtered.slice(0, 30);

    if (!limited.length) {
        dropdown.innerHTML = '<div class="branch-empty">No matches</div>';
        dropdown.classList.remove('hidden');
        return;
    }

    dropdown.innerHTML = limited.map(b =>
        `<div class="branch-item" data-branch="${escapeHtml(b.name)}">
            <span class="branch-name">${highlightMatch(b.name, q)}</span>
            <span class="branch-meta">${escapeHtml(b.date)}</span>
        </div>`
    ).join('');
    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('.branch-item').forEach(item => {
        item.addEventListener('click', () => selectBranch(item.dataset.branch));
    });
}

function highlightMatch(name, query) {
    if (!query) return escapeHtml(name);
    const idx = name.toLowerCase().indexOf(query);
    if (idx < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, idx))
        + `<strong>${escapeHtml(name.slice(idx, idx + query.length))}</strong>`
        + escapeHtml(name.slice(idx + query.length));
}

function selectBranch(name) {
    selectedBranch = name;
    document.getElementById('branch-input').value = name;
    document.getElementById('branch-dropdown').classList.add('hidden');
    document.getElementById('deploy-btn').disabled = gitDirty || !name;
}

async function stashChanges() {
    const btn = document.getElementById('stash-btn');
    btn.disabled = true;
    btn.textContent = 'Stashing...';
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/git/stash`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            updateDirtyState(false, 0);
        } else {
            showError('Stash failed: ' + data.message);
        }
    } catch (e) {
        showError('Stash error: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Stash';
}

async function startDeploy() {
    if (!selectedBranch) return;
    if (!confirm(`Deploy branch "${selectedBranch}"?\n\nThis will:\n- Pull latest changes\n- Gradle clean + build\n- Copy artifacts\n- Restart Tomcat`)) return;

    const btn = document.getElementById('deploy-btn');
    btn.disabled = true;
    btn.textContent = 'Deploying...';
    document.getElementById('deploy-log-wrap').classList.remove('hidden');
    document.getElementById('deploy-log').textContent = 'Starting deploy...';

    const baseUrl = await getApiUrl();
    try {
        await fetch(`${baseUrl}/deploy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch: selectedBranch }),
        });
        streamDeployLog();
    } catch (e) {
        document.getElementById('deploy-log').textContent = 'Error: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Deploy';
    }
}

function renderDeployLog(logLines) {
    const logEl = document.getElementById('deploy-log');
    logEl.innerHTML = logLines.map(line => linkifyCommands(escapeHtml(line))).join('\n');
    // Bind click handlers for executable commands
    logEl.querySelectorAll('.exec-cmd').forEach(el => {
        el.addEventListener('click', () => execCommand(el.dataset.cmd, el));
    });
    logEl.scrollTop = logEl.scrollHeight;
}

const CMD_PATTERN = /(?:^\s*|:\s+)((?:tail|head|cat|df|du|ls|cd|git|\.\/gradlew|ps|free|uptime)\s[^\n]{5,})/g;

function linkifyCommands(safeLine) {
    return safeLine.replace(CMD_PATTERN, (match, cmd) => {
        const trimmed = cmd.trim();
        return match.replace(cmd, `<span class="exec-cmd" data-cmd="${trimmed}" title="Click to run">${trimmed}</span>`);
    });
}

async function execCommand(cmd, el) {
    el.classList.add('exec-running');
    el.textContent = cmd + ' (running...)';
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/exec`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cmd }),
            signal: AbortSignal.timeout(35000),
        });
        const data = await res.json();
        el.classList.remove('exec-running');
        el.textContent = cmd;

        // Insert result block after the command line
        const resultEl = document.createElement('div');
        resultEl.className = 'exec-result' + (data.ok ? '' : ' exec-result-err');
        resultEl.textContent = data.output;
        el.closest('.exec-cmd')?.after(resultEl) || el.parentElement.appendChild(resultEl);
    } catch (e) {
        el.classList.remove('exec-running');
        el.textContent = cmd + ' (error: ' + e.message + ')';
    }
}

async function streamDeployLog() {
    const baseUrl = await getApiUrl();
    const btn = document.getElementById('deploy-btn');

    try {
        const es = new EventSource(`${baseUrl}/deploy/stream`);
        es.onmessage = (e) => {
            const data = JSON.parse(e.data);
            renderDeployLog(data.log);
        };
        es.addEventListener('done', () => {
            es.close();
            btn.disabled = false;
            btn.textContent = 'Deploy';
            loadBranches();
            setTimeout(refresh, 3000);
        });
        es.onerror = () => {
            es.close();
            btn.disabled = false;
            btn.textContent = 'Deploy';
        };
    } catch {
        pollDeployLog();
    }
}

async function pollDeployLog() {
    const baseUrl = await getApiUrl();
    const btn = document.getElementById('deploy-btn');
    const poll = setInterval(async () => {
        try {
            const res = await fetch(`${baseUrl}/deploy/status`);
            const data = await res.json();
            renderDeployLog(data.log);
            if (!data.in_progress) {
                clearInterval(poll);
                btn.disabled = false;
                btn.textContent = 'Deploy';
                loadBranches();
                setTimeout(refresh, 3000);
            }
        } catch { /* retry */ }
    }, 2000);
}

async function checkDeployStatus() {
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/deploy/status`);
        const data = await res.json();
        if (data.in_progress) {
            document.getElementById('deploy-btn').disabled = true;
            document.getElementById('deploy-btn').textContent = 'Deploying...';
            document.getElementById('deploy-log-wrap').classList.remove('hidden');
            renderDeployLog(data.log);
            streamDeployLog();
        }
    } catch { /* ignore */ }
}

// ── Log highlighting ──

const LOG_ERROR_RE = /\b(error|exception|fatal|fail(ed|ure)?|crash|panic|severe|critical|stacktrace|caused\s+by|abort(ed)?)\b/i;

function highlightLogErrors(text) {
    return text.split('\n').map(line => {
        const safe = escapeHtml(line);
        if (LOG_ERROR_RE.test(line)) {
            return `<span class="log-error-line">${safe}</span>`;
        }
        return safe;
    }).join('\n');
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
        const text = await res.text();
        body.innerHTML = highlightLogErrors(text);
        const lastError = body.querySelector('.log-error-line:last-of-type');
        if (lastError) {
            lastError.scrollIntoView({ block: 'center' });
        } else {
            body.scrollTop = body.scrollHeight;
        }
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

async function stopAgent(name, btn) {
    if (!confirm(`Stop agent "${name}"?`)) return;
    btn.disabled = true;
    btn.textContent = '\u23F3';
    const baseUrl = await getApiUrl();
    try {
        const res = await fetch(`${baseUrl}/stop/agent/${name}`, {
            method: 'POST',
            signal: AbortSignal.timeout(120000),
        });
        const data = await res.json();
        btn.textContent = data.ok ? '\u2713' : '\u2717';
        if (data.ok) chrome.runtime.sendMessage({ action: 'agentStopped', name }).catch(() => {});
        if (!data.ok) showError(`Agent "${name}" stop failed: ` + data.message);
    } catch (e) {
        btn.textContent = '\u2717';
        showError(`Agent "${name}" stop error: ` + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x25A0;';
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
        if (data.ok) chrome.runtime.sendMessage({ action: 'agentStarted', name }).catch(() => {});
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
