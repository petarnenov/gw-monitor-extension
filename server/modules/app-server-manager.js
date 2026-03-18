function registerRoutes(app, config, adapters) {
    const appServer = adapters.appServer;

    app.post('/stop/tomcat', async (_req, res) => {
        try {
            console.log('[stop] Stopping app server...');
            await appServer.stop();
            res.json({ ok: true, message: 'Tomcat stopped' });
        } catch (e) {
            console.error('[stop] App server stop failed:', e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/restart/tomcat', async (_req, res) => {
        try {
            console.log('[restart] Stopping app server...');
            await appServer.stop();
            console.log('[restart] Starting app server...');
            await appServer.start();
            res.json({ ok: true, message: 'Tomcat restarted' });
        } catch (e) {
            console.error('[restart] App server restart failed:', e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });
}

module.exports = { registerRoutes };
