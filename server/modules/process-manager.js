let restartState = { in_progress: false, log: [], phase: null, started_agents: [], coordinator_ready: false };

function logRestart(msg) {
    const ts = new Date().toLocaleTimeString();
    restartState.log.push(`[${ts}] ${msg}`);
    console.log(`[full-cluster] ${msg}`);
}

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
        if (restartState.in_progress) {
            return res.status(409).json({ ok: false, message: 'Restart already in progress' });
        }
        const appServer = adapters.appServer;
        restartState = { in_progress: true, log: [], phase: 'stopping', started_agents: [], coordinator_ready: false };
        res.json({ ok: true, message: 'Full cluster restart started' });

        try {
            // Step 1: Stop Tomcat
            const tomcatStatus = await appServer.getStatus();
            if (tomcatStatus.running) {
                logRestart('Step 1/3: Stopping Tomcat...');
                await appServer.stop();
                logRestart('Tomcat stopped.');
            } else {
                logRestart('Step 1/3: Tomcat already stopped.');
            }

            // Step 2: Restart agents (coordinator first)
            logRestart('Step 2/3: Restarting all agents (coordinator first)...');
            await pm.restartAll((msg) => {
                logRestart(msg);
                // Phase tracking
                if (msg.match(/^Starting coordinator/)) {
                    restartState.phase = 'coordinator';
                    if (!restartState.started_agents.includes('coordinator')) {
                        restartState.started_agents.push('coordinator');
                    }
                } else if (msg.includes('Coordinator ready') || msg.includes('Coordinator PID alive (no Akka port') || msg.includes('WARNING: Coordinator may not be fully ready')) {
                    restartState.coordinator_ready = true;
                    restartState.phase = 'agents';
                }
                // Track individual agent starts ("Starting <name>...")
                const m = msg.match(/^Starting (\w+)\.\.\.$/);
                if (m && !restartState.started_agents.includes(m[1])) {
                    restartState.started_agents.push(m[1]);
                }
            });

            // Step 3: Start Tomcat
            logRestart('Step 3/3: Starting Tomcat...');
            restartState.phase = 'tomcat';
            await appServer.start();
            logRestart('Full cluster restart complete.');
            restartState.phase = 'complete';
        } catch (e) {
            logRestart(`FAILED: ${e.message}`);
            restartState.phase = 'failed';
            try {
                logRestart('Attempting Tomcat recovery start...');
                await appServer.start();
            } catch (startErr) {
                logRestart(`Tomcat recovery start also failed: ${startErr.message}`);
            }
        } finally {
            restartState.in_progress = false;
        }
    });

    app.get('/restart/full-cluster/status', (_req, res) => {
        res.json(restartState);
    });

    app.get('/restart/full-cluster/stream', (req, res) => {
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.flushHeaders();

        const interval = setInterval(() => {
            res.write(`data: ${JSON.stringify(restartState)}\n\n`);
            if (!restartState.in_progress) {
                clearInterval(interval);
                res.write('event: done\ndata: {}\n\n');
                res.end();
            }
        }, 1000);

        req.on('close', () => clearInterval(interval));
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
