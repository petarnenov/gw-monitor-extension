/**
 * Abstract interface for app server adapters.
 * Implementations: TomcatAdapter (and future: JettyAdapter, SpringBootAdapter, etc.)
 */
class AppServerAdapter {
    constructor(config) { this.config = config; }

    /** Start the app server. */
    async start() { throw new Error('Not implemented'); }

    /** Stop the app server. gracePeriodMs = time for graceful shutdown before force kill. */
    async stop(gracePeriodMs = 15000) { throw new Error('Not implemented'); }

    /** Get process info: { pid, rss_kb, cpu_pct, started, uptime_seconds, xmx }. */
    getProcessInfo() { throw new Error('Not implemented'); }

    /**
     * Get full status including HTTP check, process info, threads, JVM, webapps, requests.
     * Returns { http_port, http_code, response_ms, running, ready, process, threads, jvm, webapps, requests_today }.
     */
    async getStatus() { throw new Error('Not implemented'); }

    /** Health check — is the app server ready to serve requests? */
    async isReady() { throw new Error('Not implemented'); }

    /** Absolute path to the main log file. */
    getLogPath() { throw new Error('Not implemented'); }

    /** List of deployed applications. */
    getDeployedApps() { throw new Error('Not implemented'); }

    /** Request count for today (if available). */
    getRequestsToday() { return 0; }

    /** JVM/runtime configuration (for Java-based servers). */
    getRuntimeConfig(pid) { return {}; }

    /** Wait for the app server process to stop, force-killing after timeout. */
    async waitForStop() { throw new Error('Not implemented'); }
}

module.exports = AppServerAdapter;
