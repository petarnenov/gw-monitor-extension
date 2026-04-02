/**
 * Deploy section — branch search, pull, stash, deploy, quick deploy, log streaming.
 */
let allBranches = [];
let selectedBranch = '';
let gitDirty = false;

async function loadBranches() {
    try {
        const [brData, stData] = await Promise.all([
            ApiClient.getBranches(),
            ApiClient.getGitStatus(),
        ]);
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
    document.getElementById('pull-btn').disabled = !selectedBranch;
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
    document.getElementById('pull-btn').disabled = !name;
}

async function stashChanges() {
    const btn = document.getElementById('stash-btn');
    btn.disabled = true;
    btn.textContent = 'Stashing...';
    try {
        const data = await ApiClient.stash();
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

async function startPull() {
    if (!selectedBranch) return;
    const btn = document.getElementById('pull-btn');
    btn.disabled = true;
    btn.textContent = 'Pulling...';
    try {
        const resp = await ApiClient.pull(selectedBranch);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.message || 'Pull failed');
        document.getElementById('deploy-log-wrap').classList.remove('hidden');
        document.getElementById('deploy-log').textContent = data.message;
    } catch (e) {
        document.getElementById('deploy-log-wrap').classList.remove('hidden');
        document.getElementById('deploy-log').textContent = 'Pull error: ' + e.message;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Pull';
    }
}

async function startDeploy() {
    if (!selectedBranch) return;
    if (!confirm(`Deploy branch "${selectedBranch}"?\n\nThis will:\n- Pull latest changes\n- Gradle clean + build\n- Copy artifacts\n- Restart agents (coordinator first)\n- Restart Tomcat`)) return;

    const btn = document.getElementById('deploy-btn');
    btn.disabled = true;
    btn.textContent = 'Deploying...';
    document.getElementById('deploy-log-wrap').classList.remove('hidden');
    document.getElementById('deploy-log').textContent = 'Starting deploy...';

    try {
        await ApiClient.deploy(selectedBranch);
        streamDeployLog('deploy-btn', 'Deploy', () => loadBranches());
    } catch (e) {
        document.getElementById('deploy-log').textContent = 'Error: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Deploy';
    }
}

async function startQuickDeploy() {
    const optionsEl = document.getElementById('quick-deploy-options');
    if (optionsEl.classList.contains('hidden')) {
        optionsEl.classList.remove('hidden');
        return;
    }

    const restartTomcat = document.getElementById('qd-restart-tomcat').checked;
    const agentsRaw = document.getElementById('qd-agents').value.trim();
    const agents = agentsRaw ? agentsRaw.split(/[\s,]+/).filter(Boolean) : [];

    const parts = ['Build jar & copy'];
    if (agents.length) parts.push(`restart agents: ${agents.join(', ')}`);
    if (restartTomcat) parts.push('restart Tomcat');
    if (!confirm(`Quick Deploy?\n\n${parts.join('\n')}\n\nNo git pull — uses current local code.`)) return;

    const btn = document.getElementById('quick-deploy-btn');
    btn.disabled = true;
    btn.textContent = 'Deploying...';
    document.getElementById('deploy-log-wrap').classList.remove('hidden');
    document.getElementById('deploy-log').textContent = 'Starting quick deploy...';

    try {
        await ApiClient.quickDeploy(agents, restartTomcat);
        streamDeployLog('quick-deploy-btn', 'Quick Deploy', () => {
            document.getElementById('quick-deploy-options').classList.add('hidden');
        });
    } catch (e) {
        document.getElementById('deploy-log').textContent = 'Error: ' + e.message;
        btn.disabled = false;
        btn.textContent = 'Quick Deploy';
    }
}

async function streamDeployLog(btnId, btnLabel, onDone) {
    const btn = document.getElementById(btnId);
    try {
        const es = await ApiClient.createDeployStream();
        es.onmessage = (e) => {
            const data = JSON.parse(e.data);
            renderDeployLog(data.log);
        };
        es.addEventListener('done', () => {
            es.close();
            btn.disabled = false;
            btn.textContent = btnLabel;
            if (onDone) onDone();
            setTimeout(refresh, 3000);
        });
        es.onerror = () => {
            es.close();
            btn.disabled = false;
            btn.textContent = btnLabel;
        };
    } catch {
        pollDeployLog(btnId, btnLabel, onDone);
    }
}

async function pollDeployLog(btnId, btnLabel, onDone) {
    const btn = document.getElementById(btnId);
    const poll = setInterval(async () => {
        try {
            const data = await ApiClient.getDeployStatus();
            renderDeployLog(data.log);
            if (!data.in_progress) {
                clearInterval(poll);
                btn.disabled = false;
                btn.textContent = btnLabel;
                if (onDone) onDone();
                setTimeout(refresh, 3000);
            }
        } catch { /* retry */ }
    }, 2000);
}

function renderDeployLog(logLines) {
    const logEl = document.getElementById('deploy-log');
    logEl.innerHTML = logLines.map(line => linkifyCommands(escapeHtml(line))).join('\n');
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
    try {
        const data = await ApiClient.execCommand(cmd);
        el.classList.remove('exec-running');
        el.textContent = cmd;
        const resultEl = document.createElement('div');
        resultEl.className = 'exec-result' + (data.ok ? '' : ' exec-result-err');
        resultEl.textContent = data.output;
        el.closest('.exec-cmd')?.after(resultEl) || el.parentElement.appendChild(resultEl);
    } catch (e) {
        el.classList.remove('exec-running');
        el.textContent = cmd + ' (error: ' + e.message + ')';
    }
}

async function checkDeployStatus() {
    try {
        const data = await ApiClient.getDeployStatus();
        if (data.in_progress) {
            document.getElementById('deploy-btn').disabled = true;
            document.getElementById('deploy-btn').textContent = 'Deploying...';
            document.getElementById('deploy-log-wrap').classList.remove('hidden');
            renderDeployLog(data.log);
            streamDeployLog('deploy-btn', 'Deploy', () => loadBranches());
        }
    } catch { /* ignore */ }
}
