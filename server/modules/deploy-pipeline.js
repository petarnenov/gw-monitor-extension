const fs = require('fs');
const { runCmd, runCmdStrict, runAsync, lastLines } = require('../utils');

let deployInProgress = false;
let deployLog = [];

function logDeploy(msg) {
    const ts = new Date().toLocaleTimeString();
    deployLog.push(`[${ts}] ${msg}`);
    console.log(`[deploy] ${msg}`);
}

async function runQuickDeploy(config, adapters, agentNames, restartAppServer) {
    const appServer = adapters.appServer;
    const build = adapters.build;
    const pm = adapters.processManager;
    const BE_HOME = config.paths.deploy_target;
    const startTime = Date.now();
    const step = (name) => logDeploy(`\n── ${name} ──`);

    // 1. Build jar only
    step('Step 1/4 — Build jar');
    try {
        await build.buildJarOnly(logDeploy);
        logDeploy('Jar built successfully');
    } catch (e) {
        throw new Error(`Build jar failed:\n${lastLines(e.message, 15)}`);
    }

    const jarPath = build.getJarPath();
    const jarName = config.build.output.jar_name || 'geowealth.jar';
    if (!fs.existsSync(jarPath)) {
        throw new Error(`Jar not found at ${jarPath}`);
    }

    // 2. Copy jar to deploy target and app server
    step('Step 2/4 — Copying jar');
    try {
        await build._exec(`cp "${jarPath}" "${BE_HOME}/lib/${jarName}"`, 10000);
        logDeploy(`Copied to ${BE_HOME}/lib/`);
        await build._exec(`cp "${jarPath}" "${config.app_server.home}/webapps/ROOT/WEB-INF/lib/${jarName}"`, 10000);
        logDeploy(`Copied to app server WEB-INF/lib/`);
    } catch (e) {
        throw new Error(`Jar copy failed:\n${e.message}`);
    }

    // 3. Restart requested agents (coordinator first if present)
    step('Step 3/4 — Restarting agents');
    if (agentNames.length === 0 || !pm) {
        logDeploy('No agents selected for restart, skipping');
    } else {
        // Move coordinator to front if present
        const coordIdx = agentNames.indexOf('coordinator');
        if (coordIdx > 0) {
            agentNames.splice(coordIdx, 1);
            agentNames.unshift('coordinator');
            logDeploy('Reordered: coordinator will start first');
        }

        for (const name of agentNames) {
            if (!/^[a-z][a-z0-9]*$/.test(name)) {
                logDeploy(`Skipping invalid agent name: ${name}`);
                continue;
            }
            try {
                logDeploy(`Restarting ${name}...`);
                await pm.stopProcess(name).catch(() => {});
                await pm.startProcess(name);
                logDeploy(`${name} restarted`);

                // Wait for coordinator to be ready before starting other agents
                if (name === 'coordinator' && agentNames.length > 1 && typeof pm.waitForCoordinator === 'function') {
                    logDeploy('Waiting for coordinator to become ready...');
                    await pm.waitForCoordinator(90000, logDeploy);
                }
            } catch (e) {
                logDeploy(`WARNING: ${name} restart failed: ${e.message}`);
            }
        }
    }

    // 4. Restart app server
    step('Step 4/4 — Restarting app server');
    if (!restartAppServer) {
        logDeploy('App server restart skipped');
    } else {
        try {
            logDeploy('Stopping app server...');
            await appServer.stop();
            runCmd(`rm -f ${config.app_server.home}/bin/*.pid`);
            logDeploy('Starting app server...');
            await appServer.start();
            logDeploy('App server started');
        } catch (e) {
            throw new Error(`App server restart failed: ${e.message}`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logDeploy(`\nQuick deploy completed in ${elapsed}s`);
}

async function runDeploy(config, adapters, branch) {
    const GEO_DIR = config.paths.source;
    const step = (name) => logDeploy(`\n── ${name} ──`);
    const startTime = Date.now();
    const originalBranch = runCmdStrict(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    let stashed = false;
    let hiddenFiles = [];

    try {
        await runDeploySteps(config, adapters, branch, step, startTime, originalBranch, (s) => { stashed = s; }, (h) => { hiddenFiles = h; });
    } catch (e) {
        if (stashed) {
            logDeploy(`\nDeploy failed. Attempting to restore stash on original branch (${originalBranch})...`);
            try {
                runCmd(`git -C "${GEO_DIR}" checkout "${originalBranch}" 2>/dev/null`, 15000);
                const popOut = runCmd(`git -C "${GEO_DIR}" stash pop 2>&1`);
                if (popOut) logDeploy(popOut);
                logDeploy(`Stashed changes restored on ${originalBranch}.`);
            } catch {
                logDeploy(`WARNING: Could not auto-restore stash. Run manually:`);
                logDeploy(`  cd ${GEO_DIR} && git checkout ${originalBranch} && git stash pop`);
            }
        }
        if (hiddenFiles.length) {
            for (const f of hiddenFiles) {
                runCmd(`git -C "${GEO_DIR}" update-index --assume-unchanged "${f}" 2>/dev/null`);
            }
            logDeploy(`Restored assume-unchanged flags for ${hiddenFiles.length} file(s)`);
        }
        throw e;
    }
}

async function runDeploySteps(config, adapters, branch, step, startTime, originalBranch, setStashed, setHiddenFiles) {
    const appServer = adapters.appServer;
    const build = adapters.build;
    const GEO_DIR = config.paths.source;
    let stashed = false;

    // 1. Stash local changes
    step('Step 1/8 — Checking for local changes');
    const assumeUnchanged = runCmd(`git -C "${GEO_DIR}" ls-files -v | grep "^[a-z]" | awk '{print $2}'`);
    const skipWorktree = runCmd(`git -C "${GEO_DIR}" ls-files -v | grep "^S" | awk '{print $2}'`);
    const hiddenFiles = [assumeUnchanged, skipWorktree].filter(Boolean).join('\n').split('\n').filter(Boolean);

    if (hiddenFiles.length) {
        logDeploy(`${hiddenFiles.length} assume-unchanged/skip-worktree file(s) detected:`);
        hiddenFiles.forEach(f => logDeploy(`  ${f}`));
        logDeploy('Temporarily reverting flags to allow stash...');
        for (const f of hiddenFiles) {
            runCmd(`git -C "${GEO_DIR}" update-index --no-assume-unchanged "${f}" 2>/dev/null`);
            runCmd(`git -C "${GEO_DIR}" update-index --no-skip-worktree "${f}" 2>/dev/null`);
        }
    }

    const fullStatus = runCmd(`git -C "${GEO_DIR}" status --porcelain`);
    if (fullStatus) {
        const changedFiles = fullStatus.split('\n').filter(Boolean);
        logDeploy(`${changedFiles.length} changed file(s) detected:`);
        changedFiles.slice(0, 10).forEach(f => logDeploy(`  ${f}`));
        if (changedFiles.length > 10) logDeploy(`  ... and ${changedFiles.length - 10} more`);
        logDeploy('Stashing all changes (including untracked)...');
        try {
            const stashOut = runCmdStrict(`git -C "${GEO_DIR}" stash push -u -m "deploy-${Date.now()}" 2>&1`, 30000);
            logDeploy(stashOut || 'Stashed');
            stashed = true;
            setStashed(true);
        } catch (e) {
            throw new Error(`Stash failed: ${e.message}`);
        }
    } else {
        logDeploy('Working directory clean');
    }
    setHiddenFiles(hiddenFiles);

    // 2. Fetch
    step('Step 2/8 — Fetching latest branches');
    try {
        const fetchOut = runCmdStrict(`git -C "${GEO_DIR}" fetch --prune 2>&1`, 30000);
        logDeploy(fetchOut || 'Fetch complete');
    } catch (e) {
        logDeploy(`WARNING: Fetch failed: ${e.message}`);
        logDeploy('Proceeding with locally available data...');
    }

    // 3. Checkout and pull
    step(`Step 3/8 — Switching to branch: ${branch}`);
    logDeploy(`Current branch: ${originalBranch}`);
    if (branch !== originalBranch) {
        try {
            const checkoutOut = runCmdStrict(`git -C "${GEO_DIR}" checkout "${branch}" 2>&1`, 30000);
            logDeploy(checkoutOut || `Switched to ${branch}`);
        } catch (e) {
            throw new Error(`Checkout failed for "${branch}": ${e.message}\nMake sure the branch exists and has no conflicts.`);
        }
        const actualBranch = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
        if (actualBranch && actualBranch !== branch) {
            throw new Error(`Checkout verification failed: expected "${branch}" but on "${actualBranch}".`);
        }
    } else {
        logDeploy('Already on target branch');
    }
    logDeploy('Pulling latest from origin...');
    try {
        const pullOut = runCmdStrict(`git -C "${GEO_DIR}" pull origin "${branch}" 2>&1`, 60000);
        logDeploy(pullOut || 'Already up to date');
    } catch (e) {
        throw new Error(`Pull failed for "${branch}": ${e.message}\nCheck network connectivity and branch existence on remote.`);
    }
    const headCommit = runCmd(`git -C "${GEO_DIR}" log -1 --oneline`);
    logDeploy(`HEAD: ${headCommit}`);

    // 4. Apply stash
    if (stashed) {
        step('Step 4/8 — Applying stashed changes');
        try {
            const popOut = runCmdStrict(`git -C "${GEO_DIR}" stash pop 2>&1`);
            logDeploy(popOut || 'Stash applied successfully');
        } catch (e) {
            logDeploy(`WARNING: Stash apply had conflicts.`);
            logDeploy(`Error: ${e.message}`);
            logDeploy('Clearing conflicts to proceed with clean deploy...');
            runCmd(`git -C "${GEO_DIR}" checkout -- . 2>/dev/null`);
            runCmd(`git -C "${GEO_DIR}" clean -fd 2>/dev/null`);
            logDeploy('Your changes are preserved in stash. After deploy, apply manually:');
            logDeploy(`  cd ${GEO_DIR} && git stash pop`);
        }
    }
    if (hiddenFiles.length) {
        for (const f of hiddenFiles) {
            runCmd(`git -C "${GEO_DIR}" update-index --assume-unchanged "${f}" 2>/dev/null`);
        }
        logDeploy(`Restored assume-unchanged flags for ${hiddenFiles.length} file(s)`);
    }

    // 5. Stop app server
    step('Step 5/8 — Stopping app server');
    try {
        runCmd(`${config.app_server.home}/bin/shutdown.sh 2>&1`, 15000);
        logDeploy('Shutdown signal sent');
    } catch {
        logDeploy('Shutdown script returned error (app server may not be running)');
    }
    await appServer.waitForStop();
    logDeploy('App server stopped');

    // 6. Build (incremental first, full as fallback)
    step('Step 6/8 — Build');
    let incremental = false;
    logDeploy('Trying incremental build...');
    const incResult = await build.buildIncremental(logDeploy);
    if (incResult.success) {
        incremental = true;
        logDeploy('Incremental build succeeded');
    } else {
        logDeploy(`Incremental build failed: ${lastLines(incResult.output, 5)}`);
        logDeploy('Falling back to full build...');
        await build.buildFull(logDeploy);
    }

    // Verify build output
    const verifyMsg = build.verifyBuildOutput(incremental);
    logDeploy(verifyMsg);

    // 7. Copy artifacts
    step('Step 7/8 — Copying artifacts');
    await build.copyArtifacts(logDeploy, incremental);
    await build.postDeploy(logDeploy);
    await build.copyToAppServer(logDeploy, incremental);
    build.verifyArtifacts(logDeploy);

    // 8. Start app server
    step('Step 8/8 — Starting app server');
    try {
        await build._exec(`rm -f "${config.app_server.home}/catalina_pid.txt"`, 5000);
        await appServer.start();
        logDeploy('App server startup initiated');
    } catch (e) {
        throw new Error(`App server failed to start:\n${e.message}\n\nCheck catalina.out for details:\n  tail -50 ${config.app_server.home}/logs/catalina.out`);
    }

    // Wait for app server
    logDeploy('Waiting for app server to become available...');
    const startupCheck = config.deploy && config.deploy.startup_check ? config.deploy.startup_check : {};
    const maxAttempts = startupCheck.max_attempts || 30;
    const intervalMs = startupCheck.interval_ms || 2000;
    let serverOk = false;
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const code = runCmd(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${config.app_server.port}/ 2>/dev/null`);
            if (code === '200') {
                serverOk = true;
                break;
            }
            logDeploy(`App server not ready yet (HTTP ${code})... retrying`);
        } catch { /* not ready */ }
    }
    if (serverOk) {
        logDeploy('App server is UP and responding (HTTP 200)');
    } else {
        logDeploy(`WARNING: App server did not respond with HTTP 200 after ${maxAttempts * intervalMs / 1000}s`);
        logDeploy(`Check logs: tail -100 ${config.app_server.home}/logs/catalina.out`);
    }

    const finalBranch = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    step(`Deploy complete — branch: ${finalBranch} — ${mins}m ${secs}s`);
}

function registerRoutes(app, config, adapters) {
    app.get('/deploy/status', (_req, res) => {
        res.json({ in_progress: deployInProgress, log: deployLog });
    });

    app.get('/deploy/stream', (req, res) => {
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.flushHeaders();

        const interval = setInterval(() => {
            res.write(`data: ${JSON.stringify({ log: deployLog, in_progress: deployInProgress })}\n\n`);
            if (!deployInProgress) {
                clearInterval(interval);
                res.write('event: done\ndata: {}\n\n');
                res.end();
            }
        }, 1000);

        req.on('close', () => clearInterval(interval));
    });

    app.post('/deploy', async (req, res) => {
        if (deployInProgress) {
            return res.status(409).json({ ok: false, message: 'Deploy already in progress' });
        }
        const branch = req.body.branch;
        if (!branch || !/^[\w\-\/\.]+$/.test(branch)) {
            return res.status(400).json({ ok: false, message: 'Invalid branch name' });
        }

        deployInProgress = true;
        deployLog = [];
        res.json({ ok: true, message: `Deploy started for branch "${branch}"` });

        try {
            await runDeploy(config, adapters, branch);
        } catch (e) {
            logDeploy(`FAILED: ${e.message}`);
        } finally {
            deployInProgress = false;
        }
    });

    app.post('/quick-deploy', async (req, res) => {
        if (deployInProgress) {
            return res.status(409).json({ ok: false, message: 'Deploy already in progress' });
        }
        const { agents = [], restartTomcat = true } = req.body || {};

        deployInProgress = true;
        deployLog = [];
        res.json({ ok: true, message: 'Quick deploy started' });

        try {
            await runQuickDeploy(config, adapters, agents, restartTomcat);
        } catch (e) {
            logDeploy(`FAILED: ${e.message}`);
        } finally {
            deployInProgress = false;
        }
    });
}

module.exports = { registerRoutes };
