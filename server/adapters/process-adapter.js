/**
 * Abstract interface for process manager adapters.
 * Implementations: GeoWealthAgentsAdapter (and future: PM2Adapter, SystemdAdapter, etc.)
 */
class ProcessManagerAdapter {
    constructor(config) { this.config = config; }

    /** List of configured processes from config file. */
    getConfiguredProcesses() { throw new Error('Not implemented'); }

    /** Aggregated list: configured + running + enriched metrics. */
    getAll() { throw new Error('Not implemented'); }

    /** Start a process by name. */
    async startProcess(name) { throw new Error('Not implemented'); }

    /** Stop a process by name. */
    async stopProcess(name) { throw new Error('Not implemented'); }

    /** Restart all processes. */
    async restartAll() { throw new Error('Not implemented'); }

    /** Update memory config for a process. Returns true if found and updated. */
    updateMemory(name, value) { throw new Error('Not implemented'); }

    /** Update autostart config for a process. Returns true if found and updated. */
    updateAutostart(name, enabled) { throw new Error('Not implemented'); }

    /** Path to log file for a process. */
    getLogPath(name) { throw new Error('Not implemented'); }

    /** Check if a process PID file exists (i.e., process is known). */
    processExists(name) { throw new Error('Not implemented'); }
}

module.exports = ProcessManagerAdapter;
