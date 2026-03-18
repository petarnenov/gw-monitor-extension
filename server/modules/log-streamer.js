const fs = require('fs');
const { runCmd } = require('../utils');

function registerRoutes(app, config) {
    app.get('/logs/tomcat', (req, res) => {
        const lines = parseInt(req.query.lines, 10) || 200;
        const capped = Math.min(lines, 2000);
        const mainLog = config.app_server.logs && config.app_server.logs.main
            ? config.app_server.logs.main
            : 'logs/catalina.out';
        const logFile = `${config.app_server.home}/${mainLog}`;
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
        const lines = parseInt(req.query.lines, 10) || 200;
        const capped = Math.min(lines, 2000);
        const logFileName = config.agents && config.agents.log_file ? config.agents.log_file : 'stdout.log';
        const logFile = `${config.paths.logs}/${name}/${logFileName}`;
        if (!fs.existsSync(logFile)) {
            return res.status(404).type('text/plain').send(`Log not found: ${name}/${logFileName}`);
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
