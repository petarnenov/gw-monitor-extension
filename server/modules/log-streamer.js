const fs = require('fs');
const { runCmd } = require('../utils');

function registerRoutes(app, config, adapters) {
    app.get('/logs/tomcat', (req, res) => {
        const lines = parseInt(req.query.lines, 10) || 200;
        const capped = Math.min(lines, 2000);
        const logFile = adapters.appServer.getLogPath();
        try {
            const output = runCmd(`tail -n ${capped} "${logFile}" 2>/dev/null`, 15000);
            res.type('text/plain').send(output || '(empty)');
        } catch {
            res.status(404).type('text/plain').send('Log file not found');
        }
    });

    app.get('/logs/agent/:name', (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).type('text/plain').send('Invalid agent name');
        }
        if (!adapters.processManager) {
            return res.status(404).type('text/plain').send('No process manager configured');
        }
        const lines = parseInt(req.query.lines, 10) || 200;
        const capped = Math.min(lines, 2000);
        const logFile = adapters.processManager.getLogPath(name);
        if (!fs.existsSync(logFile)) {
            return res.status(404).type('text/plain').send(`Log not found: ${logFile}`);
        }
        try {
            const output = runCmd(`tail -n ${capped} "${logFile}" 2>/dev/null`, 15000);
            res.type('text/plain').send(output || '(empty)');
        } catch {
            res.status(500).type('text/plain').send('Error reading log');
        }
    });
}

module.exports = { registerRoutes };
