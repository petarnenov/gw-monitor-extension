/**
 * System stats renderer — uptime, load, RAM/swap/disk bars.
 * Also: freeRam, clearSwap, restartServer actions.
 */
function renderSystemStats(sys) {
    document.getElementById('uptime').textContent = formatUptime(sys.uptime_seconds);
    document.getElementById('load').textContent =
        sys.load_average.map(l => l.toFixed(2)).join(' / ') + ` (${sys.cpus} cores)`;

    setBar('ram', sys.memory.used, sys.memory.total,
        `${formatBytes(sys.memory.used)} / ${formatBytes(sys.memory.total)}`);
    setBar('swap', sys.memory.swap_used, sys.memory.swap_total,
        `${formatBytes(sys.memory.swap_used)} / ${formatBytes(sys.memory.swap_total)}`);
    setBar('disk', sys.disk.used, sys.disk.total,
        `${formatBytes(sys.disk.used)} / ${formatBytes(sys.disk.total)} (${sys.disk.use_pct})`);
}

async function freeRam() {
    if (!confirm('Free RAM? This will drop filesystem caches and trigger GC on all Java processes.')) return;
    const btn = document.getElementById('free-ram-btn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Freeing...';
    try {
        const data = await ApiClient.freeRam();
        btn.textContent = data.ok ? '\u2713 Done' : '\u2717 Failed';
        if (!data.ok) showError('Free RAM failed: ' + data.message);
    } catch (e) {
        btn.textContent = '\u2717 Error';
        showError('Free RAM error: ' + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x1F9F9; Free RAM';
        refresh();
    }, 3000);
}

async function clearSwap() {
    if (!confirm('Clear swap? This will run swapoff/swapon which may briefly increase RAM usage.')) return;
    const btn = document.getElementById('clear-swap-btn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Clearing...';
    try {
        const data = await ApiClient.clearSwap();
        btn.textContent = data.ok ? '\u2713 Done' : '\u2717 Failed';
        if (!data.ok) showError('Clear swap failed: ' + data.message);
    } catch (e) {
        btn.textContent = '\u2717 Error';
        showError('Clear swap error: ' + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x1F9F9; Clear Swap';
        refresh();
    }, 3000);
}

async function restartServer() {
    if (!confirm('Restart the status server?')) return;
    const btn = document.getElementById('restart-server-btn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Restarting...';
    try {
        await ApiClient.restartServer();
    } catch { /* Expected — server exits before responding */ }
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            await ApiClient.getStatus(3000);
            btn.disabled = false;
            btn.innerHTML = '&#x21bb; Server';
            await refresh();
            return;
        } catch { /* not up yet */ }
    }
    btn.disabled = false;
    btn.innerHTML = '&#x21bb; Server';
    showError('Server did not come back after restart');
}
