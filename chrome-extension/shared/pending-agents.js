/**
 * Shared pending agent tracking logic.
 * Used by both popup (poll loop) and background (health check filter).
 */
const PendingAgents = (() => {
    const TTL_MS = 5 * 60 * 1000; // 5 minutes

    let map = new Map(); // name → timestamp

    async function load() {
        const { pendingRestarts } = await AppStorage.get(StorageKeys.PENDING_RESTARTS);
        map = new Map();
        if (pendingRestarts && typeof pendingRestarts === 'object') {
            const now = Date.now();
            for (const [name, ts] of Object.entries(pendingRestarts)) {
                if (now - ts < TTL_MS) {
                    map.set(name, ts);
                }
            }
        }
    }

    async function save() {
        await AppStorage.set({ [StorageKeys.PENDING_RESTARTS]: Object.fromEntries(map) });
    }

    function mark(name) {
        map.set(name, Date.now());
    }

    function remove(name) {
        map.delete(name);
    }

    function has(name) {
        return map.has(name);
    }

    function size() {
        return map.size;
    }

    function names() {
        return [...map.keys()];
    }

    function entries() {
        return [...map.entries()];
    }

    /**
     * Reconcile pending agents with status data.
     * Removes agents that are now accessible or have expired.
     * Returns true if any changes were made.
     */
    function reconcile(statusData) {
        let changed = false;
        const now = Date.now();

        // Expire stale entries
        for (const [name, ts] of [...map]) {
            if (now - ts >= TTL_MS) {
                map.delete(name);
                changed = true;
            }
        }

        // Resolve accessible agents
        const agents = statusData.agents?.agents || [];
        for (const [name] of [...map]) {
            const agent = agents.find(a => a.name === name);
            if (agent && agent.running && agent.accessible) {
                map.delete(name);
                changed = true;
            }
        }

        return changed;
    }

    /**
     * Get set of pending names not yet expired (for background filtering).
     */
    function getPendingSet(pendingRestarts) {
        const now = Date.now();
        return new Set(
            Object.entries(pendingRestarts || {})
                .filter(([, ts]) => now - ts < TTL_MS)
                .map(([name]) => name)
        );
    }

    return { load, save, mark, remove, has, size, names, entries, reconcile, getPendingSet, TTL_MS };
})();
