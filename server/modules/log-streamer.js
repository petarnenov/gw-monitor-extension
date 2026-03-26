const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCmd } = require('../utils');

function registerRoutes(app, config, adapters) {
    app.get('/logs/server', (req, res) => {
        const lines = parseInt(req.query.lines, 10) || 200;
        const capped = Math.min(lines, 2000);
        const logType = req.query.type === 'error' ? 'error' : 'out';

        // Try PM2 log paths
        const pm2Home = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
        const appName = config.pm2?.app_name || 'gw-monitor';
        const logFile = path.join(pm2Home, 'logs', `${appName}-${logType}.log`);

        if (!fs.existsSync(logFile)) {
            return res.status(404).type('text/plain').send(`Server log not found: ${logFile}`);
        }
        try {
            const output = runCmd(`tail -n ${capped} "${logFile}" 2>/dev/null`, 15000);
            res.type('text/plain').send(output || '(empty)');
        } catch {
            res.status(500).type('text/plain').send('Error reading server log');
        }
    });

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
