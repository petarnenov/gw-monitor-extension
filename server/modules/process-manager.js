function registerRoutes(app, config, adapters) {
    const pm = adapters.processManager;
    if (!pm) return; // No process manager configured

    app.post('/stop/agent/:name', async (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).json({ ok: false, message: 'Invalid agent name' });
        }
        if (!pm.processExists(name)) {
            return res.status(404).json({ ok: false, message: `Agent "${name}" not found or not running` });
        }
        try {
            console.log(`[stop] Stopping agent ${name}...`);
            await pm.stopProcess(name);
            res.json({ ok: true, message: `Agent "${name}" stopped` });
        } catch (e) {
            console.error(`[stop] Agent ${name} stop failed:`, e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/restart/agent/:name', async (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).json({ ok: false, message: 'Invalid agent name' });
        }
        if (!pm.processExists(name)) {
            return res.status(404).json({ ok: false, message: `Agent "${name}" not found` });
        }
        try {
            console.log(`[restart] Stopping agent ${name}...`);
            await pm.stopProcess(name);
            console.log(`[restart] Starting agent ${name}...`);
            await pm.startProcess(name);
            console.log(`[restart] Agent ${name} start command completed, accessibility will be checked by client`);
            res.json({ ok: true, message: `Agent "${name}" restarted` });
        } catch (e) {
            console.error(`[restart] Agent ${name} restart failed:`, e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/restart/agents', async (_req, res) => {
        try {
            console.log('[restart] Restarting all agents (coordinator first)...');
            await pm.restartAll((msg) => console.log(`[restart] ${msg}`));
            res.json({ ok: true, message: 'All agents restarted (coordinator first)' });
        } catch (e) {
            console.error('[restart] All agents restart failed:', e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/restart/full-cluster', async (_req, res) => {
        const appServer = adapters.appServer;
        try {
            // Step 1: Check if Tomcat is running, stop it first
            const tomcatStatus = await appServer.getStatus();
            if (tomcatStatus.running) {
                console.log('[full-cluster] Step 1/3: Stopping Tomcat...');
                await appServer.stop();
                console.log('[full-cluster] Tomcat stopped.');
            } else {
                console.log('[full-cluster] Step 1/3: Tomcat already stopped.');
            }

            // Step 2: Restart all agents (coordinator first, wait for it to be ready)
            console.log('[full-cluster] Step 2/3: Restarting all agents (coordinator first)...');
            await pm.restartAll((msg) => console.log(`[full-cluster] ${msg}`));

            // Step 3: Start Tomcat
            console.log('[full-cluster] Step 3/3: Starting Tomcat...');
            await appServer.start();
            console.log('[full-cluster] Tomcat started. Full cluster restart complete.');

            res.json({ ok: true, message: 'Full cluster restart complete (Tomcat stopped → agents restarted → Tomcat started)' });
        } catch (e) {
            console.error('[full-cluster] Full cluster restart failed:', e.message);
            // Try to start Tomcat even if something failed
            try {
                console.log('[full-cluster] Attempting Tomcat recovery start...');
                await appServer.start();
            } catch (startErr) {
                console.error('[full-cluster] Tomcat recovery start also failed:', startErr.message);
            }
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.put('/config/agent/:name/autostart', (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).json({ ok: false, message: 'Invalid agent name' });
        }
        const enabled = !!req.body.enabled;
        try {
            const updated = pm.updateAutostart(name, enabled);
            if (updated) {
                console.log(`[config] Updated ${name} autostart to ${enabled}`);
                res.json({ ok: true, message: `${name} autostart ${enabled ? 'enabled' : 'disabled'}` });
            } else {
                res.status(404).json({ ok: false, message: `Agent "${name}" not found in config` });
            }
        } catch (e) {
            console.error(`[config] Failed to update ${name} autostart:`, e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.put('/config/agent/:name/memory', (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).json({ ok: false, message: 'Invalid agent name' });
        }
        const memory = parseInt(req.body.memory, 10);
        if (!memory || memory < 1 || memory > 64) {
            return res.status(400).json({ ok: false, message: 'Memory must be between 1 and 64 GB' });
        }
        try {
            const updated = pm.updateMemory(name, memory);
            if (updated) {
                console.log(`[config] Updated ${name} max_memory to ${memory}g`);
                res.json({ ok: true, message: `${name} memory set to ${memory}g (restart needed)` });
            } else {
                res.status(404).json({ ok: false, message: `Agent "${name}" not found in config` });
            }
        } catch (e) {
            console.error(`[config] Failed to update ${name} memory:`, e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });
}

module.exports = { registerRoutes };
