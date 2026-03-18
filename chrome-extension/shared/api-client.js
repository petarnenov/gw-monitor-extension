/**
 * Unified API client for communicating with the server.
 * Used by both popup and background service worker.
 */
const ApiClient = (() => {
    const DEFAULT_URL = 'http://localhost:7103';

    async function getBaseUrl() {
        const { serverUrl } = await chrome.storage.local.get('serverUrl');
        return serverUrl || DEFAULT_URL;
    }

    async function request(method, path, { body, timeout = 10000 } = {}) {
        const baseUrl = await getBaseUrl();
        const opts = {
            method,
            signal: AbortSignal.timeout(timeout),
        };
        if (body) {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(`${baseUrl}${path}`, opts);
        return res;
    }

    async function json(method, path, opts) {
        const res = await request(method, path, opts);
        return res.json();
    }

    async function text(method, path, opts) {
        const res = await request(method, path, opts);
        return res.text();
    }

    return {
        DEFAULT_URL,
        getBaseUrl,

        getStatus: (timeout = 15000) => json('GET', '/status', { timeout }),
        getClientConfig: () => json('GET', '/config/client'),
        ping: () => text('GET', '/ping'),

        // App server
        stopAppServer: () => json('POST', '/stop/tomcat', { timeout: 120000 }),
        restartAppServer: () => json('POST', '/restart/tomcat', { timeout: 120000 }),

        // Agents / processes
        stopProcess: (name) => json('POST', `/stop/agent/${name}`, { timeout: 120000 }),
        restartProcess: (name) => json('POST', `/restart/agent/${name}`, { timeout: 120000 }),
        restartAllProcesses: () => json('POST', '/restart/agents', { timeout: 300000 }),
        updateProcessMemory: (name, memory) => json('PUT', `/config/agent/${name}/memory`, { body: { memory } }),
        updateProcessAutostart: (name, enabled) => json('PUT', `/config/agent/${name}/autostart`, { body: { enabled } }),

        // Git
        getBranches: () => json('GET', '/git/branches', { timeout: 30000 }),
        getGitStatus: () => json('GET', '/git/status'),
        stash: () => json('POST', '/git/stash'),
        pull: (branch) => request('POST', '/pull', { body: { branch }, timeout: 60000 }),

        // Deploy
        deploy: (branch) => json('POST', '/deploy', { body: { branch } }),
        quickDeploy: (agents, restartTomcat) => json('POST', '/quick-deploy', { body: { agents, restartTomcat } }),
        getDeployStatus: () => json('GET', '/deploy/status'),
        createDeployStream: async () => {
            const baseUrl = await getBaseUrl();
            return new EventSource(`${baseUrl}/deploy/stream`);
        },

        // Logs
        getLogs: (type, name, lines = 200) => {
            const path = type === 'tomcat'
                ? `/logs/tomcat?lines=${lines}`
                : `/logs/agent/${name}?lines=${lines}`;
            return text('GET', path, { timeout: 15000 });
        },

        // System
        freeRam: () => json('POST', '/system/free-ram', { timeout: 60000 }),
        clearSwap: () => json('POST', '/system/clear-swap', { timeout: 120000 }),
        restartServer: () => request('POST', '/restart/server', { timeout: 10000 }),

        // Exec
        execCommand: (cmd) => json('POST', '/exec', { body: { cmd }, timeout: 35000 }),
    };
})();
