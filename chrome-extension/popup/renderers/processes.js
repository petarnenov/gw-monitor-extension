/**
 * Agents/processes table renderer + start/stop/restart/memory/autostart actions + poll loop.
 */
let pollTimer = null;
let pollInFlight = false;
let pollErrorCount = 0;

function renderProcesses(ag) {
    document.getElementById('agent-summary').textContent =
        `(${ag.running}/${ag.total} running, ${ag.healthy} healthy)`;

    const tbody = document.getElementById('agents-tbody');
    tbody.innerHTML = '';
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

        const isPending = PendingAgents.has(a.name);
        let statusHtml;
        if (isPending) {
            statusHtml = '<span class="dot yellow"></span>Starting\u2026';
        } else if (a.running) {
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
              ${a.running ? `<button class="stop-agent-btn stop-btn-sm" data-agent="${escapeHtml(a.name)}" title="Stop ${escapeHtml(a.name)}"${isPending ? ' disabled' : ''}>&#x25A0;</button>` : ''}
              <button class="restart-agent-btn restart-btn-sm" data-agent="${escapeHtml(a.name)}" title="${a.running ? 'Restart' : 'Start'} ${escapeHtml(a.name)}"${isPending ? ' disabled' : ''}>&#x21bb;</button>
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

async function restartAgent(name, btn) {
    if (!confirm(`Restart agent "${name}"?`)) return;
    btn.disabled = true;
    btn.textContent = '\u23F3';
    PendingAgents.mark(name);
    await PendingAgents.save();
    try {
        const data = await ApiClient.restartProcess(name);
        if (!data.ok) {
            PendingAgents.remove(name);
            await PendingAgents.save();
            btn.textContent = '\u2717';
            showError(`Agent "${name}" restart failed: ` + data.message);
            setTimeout(() => { btn.disabled = false; btn.innerHTML = '&#x21bb;'; }, 3000);
            return;
        }
        chrome.runtime.sendMessage({ action: 'agentStarted', name }).catch(() => {});
        startPollLoop();
    } catch (e) {
        PendingAgents.remove(name);
        await PendingAgents.save();
        btn.textContent = '\u2717';
        showError(`Agent "${name}" restart error: ` + e.message);
        setTimeout(() => { btn.disabled = false; btn.innerHTML = '&#x21bb;'; }, 3000);
    }
}

async function stopAgent(name, btn) {
    if (!confirm(`Stop agent "${name}"?`)) return;
    btn.disabled = true;
    btn.textContent = '\u23F3';
    if (PendingAgents.has(name)) {
        PendingAgents.remove(name);
        await PendingAgents.save();
    }
    try {
        const data = await ApiClient.stopProcess(name);
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

async function restartAllAgents() {
    if (!confirm('Restart ALL agents?\nThis will: Stop Tomcat \u2192 Start Coordinator \u2192 Wait for ready \u2192 Start Agents \u2192 Start Tomcat.\nMay take several minutes.')) return;
    const btn = document.getElementById('restart-all-agents-btn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Starting...';

    try {
        const data = await ApiClient.restartFullCluster();
        if (!data.ok) {
            showError('Full cluster restart failed: ' + data.message);
            btn.textContent = '\u2717 Failed';
            setTimeout(() => { btn.disabled = false; btn.innerHTML = '&#x21bb; Restart All'; }, 5000);
            return;
        }
        streamRestartProgress(btn);
    } catch (e) {
        showError('Full cluster restart error: ' + e.message);
        btn.textContent = '\u2717 Error';
        setTimeout(() => { btn.disabled = false; btn.innerHTML = '&#x21bb; Restart All'; }, 5000);
    }
}

const RESTART_PHASE_LABELS = {
    stopping: '\u23F3 Stopping agents...',
    coordinator: '\u23F3 Starting coordinator...',
    agents: '\u23F3 Starting agents...',
    tomcat: '\u23F3 Starting Tomcat...',
    complete: '\u2713 Complete',
    failed: '\u2717 Failed',
};

function updateRestartUI(data, btn) {
    const logEl = document.getElementById('restart-log');
    logEl.textContent = data.log.join('\n');
    logEl.scrollTop = logEl.scrollHeight;

    if (data.phase) {
        btn.textContent = RESTART_PHASE_LABELS[data.phase] || '\u23F3 Working...';
    }

    // Mark started agents as pending
    for (const name of data.started_agents || []) {
        if (!PendingAgents.has(name)) {
            PendingAgents.mark(name);
        }
    }

    // Coordinator ready — remove from pending so poll can show it as green
    if (data.coordinator_ready && PendingAgents.has('coordinator')) {
        PendingAgents.remove('coordinator');
    }
}

function onRestartDone(btn) {
    PendingAgents.save();
    startPollLoop();
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x21bb; Restart All';
        refresh();
    }, 3000);
    setTimeout(() => document.getElementById('restart-log-wrap').classList.add('hidden'), 15000);
}

function streamRestartProgress(btn) {
    const logWrap = document.getElementById('restart-log-wrap');
    logWrap.classList.remove('hidden');
    document.getElementById('restart-log').textContent = 'Connecting...';

    ApiClient.createRestartStream().then(es => {
        es.onmessage = (e) => {
            updateRestartUI(JSON.parse(e.data), btn);
        };
        es.addEventListener('done', () => {
            es.close();
            onRestartDone(btn);
        });
        es.onerror = () => {
            es.close();
            pollRestartProgress(btn);
        };
    }).catch(() => {
        pollRestartProgress(btn);
    });
}

function pollRestartProgress(btn) {
    const logWrap = document.getElementById('restart-log-wrap');
    logWrap.classList.remove('hidden');

    const poll = setInterval(async () => {
        try {
            const data = await ApiClient.getRestartStatus();
            updateRestartUI(data, btn);
            if (!data.in_progress) {
                clearInterval(poll);
                onRestartDone(btn);
            }
        } catch { /* retry */ }
    }, 2000);
}

async function checkRestartStatus() {
    try {
        const data = await ApiClient.getRestartStatus();
        if (data.in_progress) {
            const btn = document.getElementById('restart-all-agents-btn');
            btn.disabled = true;
            streamRestartProgress(btn);
        }
    } catch { /* ignore */ }
}

async function editAgentMemory(name, current) {
    const newMem = prompt(`Set max memory (GB) for "${name}":`, current || '4');
    if (newMem === null) return;
    const val = parseInt(newMem, 10);
    if (!val || val < 1 || val > 64) {
        return showError('Memory must be between 1 and 64 GB');
    }
    try {
        const data = await ApiClient.updateProcessMemory(name, val);
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
    try {
        const data = await ApiClient.updateProcessAutostart(name, enabled);
        if (!data.ok) {
            cb.checked = !enabled;
            showError(data.message);
        }
    } catch (e) {
        cb.checked = !enabled;
        showError('Failed to update autostart: ' + e.message);
    }
}

// ── Poll loop for pending agents ──

function startPollLoop() {
    if (pollTimer) return;
    pollErrorCount = 0;
    pollTimer = setInterval(pollPendingAgents, 5000);
}

function stopPollLoop() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function resumePendingPolls() {
    if (PendingAgents.size() > 0) startPollLoop();
}

async function pollPendingAgents() {
    if (PendingAgents.size() === 0) { stopPollLoop(); return; }
    if (pollInFlight) return;
    pollInFlight = true;

    try {
        const data = await ApiClient.getStatus();
        const changed = PendingAgents.reconcile(data);
        if (changed) await PendingAgents.save();
        const checkNow = Date.now();
        await AppStorage.set({
            [StorageKeys.LAST_STATUS]: data,
            [StorageKeys.LAST_CHECK]: checkNow,
            [StorageKeys.ERROR]: null,
        });
        render(data, checkNow);
        pollErrorCount = 0;
        if (PendingAgents.size() === 0) stopPollLoop();
    } catch (e) {
        pollErrorCount++;
        if (pollErrorCount === 3) {
            showError('Status poll failing: ' + e.message);
        }
    }
    finally { pollInFlight = false; }
}
