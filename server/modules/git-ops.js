const fs = require('fs');
const { runCmd, runCmdStrict } = require('../utils');

function setupGitAuth(config) {
    const GEO_DIR = config.paths.source;
    const gitAuth = config.git && config.git.auth ? config.git.auth : {};
    const token = process.env[gitAuth.token_env || 'GITLAB_TOKEN'] || '';
    const user = process.env[gitAuth.user_env || 'GITLAB_USER'] || (gitAuth.default_user || 'oauth2');
    const askpassScript = (config.git && config.git.askpass_script) || '/tmp/gw-git-askpass.sh';

    if (token) {
        fs.writeFileSync(askpassScript, `#!/bin/sh\ncase "$1" in\n*Username*) echo "${user}";;\n*Password*) echo "${token}";;\nesac\n`, { mode: 0o700 });

        process.env.GIT_ASKPASS = askpassScript;
        process.env.GIT_TERMINAL_PROMPT = '0';

        const currentUrl = runCmd(`git -C "${GEO_DIR}" remote get-url origin`);
        const sshMatch = currentUrl.match(/^git@gitlab\.com:(.+?)(?:\.git)?$/);
        if (sshMatch) {
            const httpsUrl = `https://gitlab.com/${sshMatch[1]}.git`;
            runCmd(`git -C "${GEO_DIR}" remote set-url origin "${httpsUrl}"`);
            console.log(`[git] Switched remote origin to HTTPS: ${httpsUrl}`);
        }
    }

    return { token, user, askpassScript };
}

function buildDeployEnv(config, gitAuthResult) {
    const JAVA_HOME = config.paths.java_home;
    return {
        ...process.env,
        JAVA_HOME,
        PATH: `${JAVA_HOME}/bin:${process.env.PATH}`,
        ...(config.agents && config.agents.env_vars ? config.agents.env_vars : {}),
        ...(gitAuthResult.token ? { GIT_ASKPASS: gitAuthResult.askpassScript, GIT_TERMINAL_PROMPT: '0' } : {}),
    };
}

function registerRoutes(app, config) {
    const GEO_DIR = config.paths.source;

    app.get('/git/branches', (_req, res) => {
        try {
            runCmd(`git -C "${GEO_DIR}" fetch --prune 2>/dev/null`, 30000);
            const current = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
            const raw = runCmd(`git -C "${GEO_DIR}" branch -r --sort=-committerdate --format="%(refname:short)|%(committerdate:relative)|%(authorname)"`, 15000);
            const branches = raw.split('\n').filter(Boolean).map(line => {
                const [ref, date, author] = line.split('|');
                const name = ref.replace(/^origin\//, '');
                return { name, date, author };
            }).filter(b => b.name !== 'HEAD');
            res.json({ current, branches });
        } catch (e) {
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.get('/git/status', (_req, res) => {
        try {
            const current = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
            const porcelain = runCmd(`git -C "${GEO_DIR}" status --porcelain`);
            const dirty = !!porcelain;
            const changes = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
            res.json({ current, dirty, changes });
        } catch (e) {
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/git/stash', async (_req, res) => {
        try {
            const porcelain = runCmd(`git -C "${GEO_DIR}" status --porcelain`);
            if (!porcelain) {
                return res.json({ ok: true, message: 'Nothing to stash' });
            }
            const output = runCmd(`git -C "${GEO_DIR}" stash push -u -m "extension-stash-${Date.now()}" 2>&1`, 30000);
            console.log('[git] Stashed:', output);
            res.json({ ok: true, message: output });
        } catch (e) {
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/pull', (req, res) => {
        // deployInProgress check is handled by deploy-pipeline via shared state
        const branch = req.body.branch;
        if (!branch || !/^[\w\-\/\.]+$/.test(branch)) {
            return res.status(400).json({ ok: false, message: 'Invalid branch name' });
        }
        try {
            const out = runCmdStrict(`git -C "${GEO_DIR}" pull origin "${branch}" 2>&1`, 60000);
            res.json({ ok: true, message: out || 'Already up to date' });
        } catch (e) {
            res.status(500).json({ ok: false, message: e.message });
        }
    });
}

module.exports = { setupGitAuth, buildDeployEnv, registerRoutes };
