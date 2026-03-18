/**
 * Popup utility functions.
 */
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

function showError(msg) {
    document.getElementById('error-banner').classList.remove('hidden');
    document.getElementById('error-msg').textContent = msg;
}

function hideError() {
    document.getElementById('error-banner').classList.add('hidden');
}
