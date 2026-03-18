/**
 * App server (Tomcat) section renderer + stop/restart actions.
 */
function renderAppServer(tom) {
    const proc = tom.process || {};
    const threads = tom.threads || {};
    const jvm = tom.jvm || {};

    const tomOk = tom.running;
    const tomReady = tom.ready;
    const tomDot = tomOk ? (tomReady ? 'green' : 'yellow') : 'red';
    const tomLabel = tomOk ? (tomReady ? 'Ready' : 'Starting') : 'Down';
    document.getElementById('tomcat-status').innerHTML =
        `<span class="dot ${tomDot}"></span>${tomLabel} :${tom.http_port}`;
    document.getElementById('tomcat-response').textContent =
        tomOk ? `${tom.response_ms}ms` : `HTTP ${tom.http_code}`;
    document.getElementById('tomcat-uptime').textContent =
        proc.uptime_seconds ? formatUptime(proc.uptime_seconds) : '-';
    document.getElementById('tomcat-requests').textContent =
        tom.requests_today != null ? tom.requests_today.toLocaleString() : '-';

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
}

async function stopTomcat() {
    if (!confirm('Stop Tomcat? This will kill all Tomcat processes.')) return;
    const btn = document.getElementById('stop-tomcat-btn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Stopping...';
    try {
        const data = await ApiClient.stopAppServer();
        btn.textContent = data.ok ? '\u2713 Stopped' : '\u2717 Failed';
        if (!data.ok) showError('Tomcat stop failed: ' + data.message);
    } catch (e) {
        btn.textContent = '\u2717 Error';
        showError('Tomcat stop error: ' + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x25A0; Stop';
        refresh();
    }, 3000);
}

async function restartTomcat() {
    if (!confirm('Are you sure you want to restart Tomcat?')) return;
    const btn = document.getElementById('restart-tomcat-btn');
    btn.disabled = true;
    btn.textContent = '\u23F3 Restarting...';
    try {
        const data = await ApiClient.restartAppServer();
        btn.textContent = data.ok ? '\u2713 Done' : '\u2717 Failed';
        if (!data.ok) showError('Tomcat restart failed: ' + data.message);
    } catch (e) {
        btn.textContent = '\u2717 Error';
        showError('Tomcat restart error: ' + e.message);
    }
    setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = '&#x21bb; Restart';
        refresh();
    }, 3000);
}
