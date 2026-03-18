const { execSync } = require('child_process');

function registerRoutes(app, config, deployEnv) {
    const ALLOWED_CMD_PREFIXES = config.exec_whitelist || [];

    app.post('/exec', (req, res) => {
        const cmd = (req.body.cmd || '').trim();
        if (!cmd) {
            return res.status(400).json({ ok: false, output: 'No command provided' });
        }
        const baseCmd = cmd.replace(/^\s*cd\s+\S+\s*&&\s*/, '');
        const allowed = ALLOWED_CMD_PREFIXES.some(p => cmd.startsWith(p) || baseCmd.startsWith(p));
        if (!allowed) {
            return res.status(403).json({ ok: false, output: `Command not allowed: ${cmd}` });
        }
        try {
            const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', env: deployEnv, cwd: config.paths.source }).trim();
            res.json({ ok: true, output: output || '(no output)' });
        } catch (e) {
            res.json({ ok: false, output: e.stderr || e.stdout || e.message });
        }
    });
}

module.exports = { registerRoutes };
