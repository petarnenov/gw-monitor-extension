/**
 * Log viewer modal — for Tomcat and agent logs.
 */
let currentLogType = null;
let currentLogName = null;

const LOG_ERROR_RE = /\b(error|exception|fatal|fail(ed|ure)?|crash|panic|severe|critical|stacktrace|caused\s+by|abort(ed)?|warn(ing)?|timeout|no\s+route)\b/i;

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
    const lines = document.getElementById('log-lines-select').value;
    try {
        const text = await ApiClient.getLogs(currentLogType, currentLogName, lines);
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

function highlightLogErrors(text) {
    return text.split('\n').map(line => {
        const safe = escapeHtml(line);
        if (LOG_ERROR_RE.test(line)) {
            return `<span class="log-error-line">${safe}</span>`;
        }
        return safe;
    }).join('\n');
}
