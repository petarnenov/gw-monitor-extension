/**
 * Akka Cluster section renderer — shows cluster health,
 * missing essential services, and recent cluster events.
 */
function renderCluster(cluster) {
    const section = document.getElementById('cluster-section');
    const restartBtn = document.getElementById('restart-agents-cluster-btn');

    if (!cluster || cluster.healthy === null) {
        document.getElementById('cluster-status').innerHTML =
            '<span class="dot gray"></span>Unknown';
        document.getElementById('cluster-missing').classList.add('hidden');
        document.getElementById('cluster-events-wrap').classList.add('hidden');
        restartBtn.classList.add('hidden');
        return;
    }

    // Status indicator
    const statusEl = document.getElementById('cluster-status');
    if (cluster.healthy) {
        statusEl.innerHTML = '<span class="dot green"></span>Healthy';
        restartBtn.classList.add('hidden');
    } else {
        statusEl.innerHTML = '<span class="dot red"></span>Degraded';
        restartBtn.classList.remove('hidden');
    }
    if (cluster.lastEventTime) {
        statusEl.innerHTML += ` <span class="cluster-time">${cluster.lastEventTime}</span>`;
    }

    // Missing services
    const missingEl = document.getElementById('cluster-missing');
    if (cluster.missingServices && cluster.missingServices.length > 0) {
        missingEl.classList.remove('hidden');
        missingEl.innerHTML = '<div class="cluster-missing-header">Missing essential services:</div>' +
            cluster.missingServices.map(s =>
                `<span class="cluster-missing-tag">${escapeHtml(s)}</span>`
            ).join(' ');
    } else {
        missingEl.classList.add('hidden');
    }

    // Recent events
    const eventsWrap = document.getElementById('cluster-events-wrap');
    const eventsEl = document.getElementById('cluster-events');
    if (cluster.recentEvents && cluster.recentEvents.length > 0) {
        eventsWrap.classList.remove('hidden');
        eventsEl.innerHTML = cluster.recentEvents.map(ev =>
            `<div class="cluster-event">` +
            `<span class="cluster-event-time">${escapeHtml(ev.time)}</span> ` +
            `<span class="cluster-event-desc">${escapeHtml(ev.description)}</span>` +
            `</div>`
        ).join('');
    } else {
        eventsWrap.classList.add('hidden');
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Restart agents button handler (cluster recovery) — delegates to restartAllAgents() in processes.js
document.getElementById('restart-agents-cluster-btn').addEventListener('click', () => {
    restartAllAgents();
});
