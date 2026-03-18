const fs = require('fs');
const { exec } = require('child_process');
const { runCmd, runCmdStrict, runAsync, lastLines } = require('../utils');

let deployInProgress = false;
let deployLog = [];

function logDeploy(msg) {
    const ts = new Date().toLocaleTimeString();
    deployLog.push(`[${ts}] ${msg}`);
    console.log(`[deploy] ${msg}`);
}

function isDeployInProgress() {
    return deployInProgress;
}

function execSyncDeploy(cmd, deployEnv, timeout = 120000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, encoding: 'utf8', env: deployEnv, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || stdout || err.message));
            else resolve((stdout || '').trim());
        });
    });
}

async function waitForTomcatStop() {
    const pids = runCmd("pgrep -f catalina.startup.Bootstrap");
    if (!pids) { logDeploy('Tomcat was not running'); return; }
    const pidList = pids.split('\n').filter(Boolean);
    logDeploy(`Waiting for Tomcat to stop (${pidList.length} process(es): ${pidList.join(', ')})...`);
    for (let i = 0; i < 30; i++) {
        const alive = runCmd("pgrep -f catalina.startup.Bootstrap");
        if (!alive) {
            logDeploy('Tomcat stopped');
            return;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    const remaining = runCmd("pgrep -f catalina.startup.Bootstrap");
    if (remaining) {
        for (const pid of remaining.split('\n').filter(Boolean)) {
            logDeploy(`Force killing Tomcat PID ${pid}...`);
            runCmd(`kill -9 ${pid} 2>/dev/null`);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
}

function fixCorruptedJars(config) {
    const BE_HOME = config.paths.deploy_target;
    const tomcatLib = `${config.app_server.home}/webapps/ROOT/WEB-INF/lib`;
    const beLib = `${BE_HOME}/lib`;

    let fixed = 0;
    try {
        const jars = fs.readdirSync(tomcatLib).filter(f => f.endsWith('.jar'));
        for (const jar of jars) {
            const tomcatPath = `${tomcatLib}/${jar}`;
            const bePath = `${beLib}/${jar}`;
            if (fs.existsSync(bePath)) {
                const tomcatMd5 = runCmd(`md5sum "${tomcatPath}" | awk '{print $1}'`);
                const beMd5 = runCmd(`md5sum "${bePath}" | awk '{print $1}'`);
                if (tomcatMd5 && beMd5 && tomcatMd5 !== beMd5) {
                    fs.copyFileSync(bePath, tomcatPath);
                    logDeploy(`Fixed corrupted JAR: ${jar}`);
                    fixed++;
                }
            }
        }
    } catch (e) {
        logDeploy(`WARNING: JAR verification error: ${e.message}`);
    }
    if (fixed > 0) {
        logDeploy(`${fixed} corrupted JAR(s) replaced from BEServer/lib`);
    } else {
        logDeploy('All JARs verified OK');
    }
}

async function runQuickDeploy(config, deployEnv, agents, restartTomcat) {
    const BE_HOME = config.paths.deploy_target;
    const GEO_DIR = config.paths.source;
    const SBIN = config.paths.sbin;
    const TOMCAT_BIN = config.app_server.bin_dir;
    const agentEnvVars = config.agents && config.agents.env_vars
        ? Object.entries(config.agents.env_vars).map(([k, v]) => `${k}="${v}"`).join(' ')
        : '';

    const startTime = Date.now();
    const step = (name) => logDeploy(`\n── ${name} ──`);

    // 1. Gradle jar
    step('Step 1/4 — Gradle jar');
    try {
        const jarCmd = config.build.commands.jar_only || './gradlew jar';
        const out = await execSyncDeploy(`cd "${GEO_DIR}" && ${jarCmd} 2>&1`, deployEnv, 120000);
        logDeploy(lastLines(out, 5));
        logDeploy('Jar built successfully');
    } catch (e) {
        throw new Error(`Gradle jar failed:\n${lastLines(e.message, 15)}`);
    }

    const jarName = config.build.output.jar_name || 'geowealth.jar';
    const jarPath = `${GEO_DIR}/${config.build.output.jar_dir}/${jarName}`;
    if (!fs.existsSync(jarPath)) {
        throw new Error(`Jar not found at ${jarPath}`);
    }

    // 2. Copy jar
    step('Step 2/4 — Copying jar');
    try {
        await execSyncDeploy(`cp "${jarPath}" "${BE_HOME}/lib/${jarName}"`, deployEnv, 10000);
        logDeploy(`Copied to ${BE_HOME}/lib/`);
        await execSyncDeploy(`cp "${jarPath}" "${config.app_server.home}/webapps/ROOT/WEB-INF/lib/${jarName}"`, deployEnv, 10000);
        logDeploy(`Copied to Tomcat WEB-INF/lib/`);
    } catch (e) {
        throw new Error(`Jar copy failed:\n${e.message}`);
    }

    // 3. Restart requested agents
    step('Step 3/4 — Restarting agents');
    if (agents.length === 0) {
        logDeploy('No agents selected for restart, skipping');
    }
    for (const name of agents) {
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            logDeploy(`Skipping invalid agent name: ${name}`);
            continue;
        }
        try {
            logDeploy(`Restarting ${name}...`);
            await runAsync(`${SBIN}/nfstop ${name} 2>&1`, 60000).catch(() => {});
            await runAsync(`${agentEnvVars} ${SBIN}/nfstart ${name} 2>&1`, 60000);
            logDeploy(`${name} restarted`);
        } catch (e) {
            logDeploy(`WARNING: ${name} restart failed: ${e.message}`);
        }
    }

    // 4. Restart Tomcat
    step('Step 4/4 — Restarting Tomcat');
    if (!restartTomcat) {
        logDeploy('Tomcat restart skipped');
    } else {
        try {
            logDeploy('Stopping Tomcat...');
            await runAsync(`${TOMCAT_BIN}/shutdown.sh 2>&1`, 30000).catch(() => {});
            await runAsync('sleep 5');
            const pids = runCmd("pgrep -f catalina.startup.Bootstrap");
            if (pids) {
                for (const pid of pids.split('\n').filter(Boolean)) {
                    await runAsync(`kill -9 ${pid} 2>/dev/null`).catch(() => {});
                }
                await runAsync('sleep 2');
            }
            runCmd(`rm -f ${config.app_server.home}/bin/*.pid`);
            logDeploy('Starting Tomcat...');
            await runAsync(`${TOMCAT_BIN}/startup.sh 2>&1`);
            logDeploy('Tomcat started');
        } catch (e) {
            throw new Error(`Tomcat restart failed: ${e.message}`);
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logDeploy(`\nQuick deploy completed in ${elapsed}s`);
}

async function runDeploy(config, deployEnv, branch) {
    const GEO_DIR = config.paths.source;
    const step = (name) => logDeploy(`\n── ${name} ──`);
    const startTime = Date.now();
    const originalBranch = runCmdStrict(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    let stashed = false;
    let hiddenFiles = [];

    try {
        await runDeploySteps(config, deployEnv, branch, step, startTime, originalBranch, (s) => { stashed = s; }, (h) => { hiddenFiles = h; });
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

async function runDeploySteps(config, deployEnv, branch, step, startTime, originalBranch, setStashed, setHiddenFiles) {
    const BE_HOME = config.paths.deploy_target;
    const GEO_DIR = config.paths.source;
    let stashed = false;

    // 1. Stash local changes
    step('Step 1/8 — Checking for local changes');
    const status = runCmd(`git -C "${GEO_DIR}" status --porcelain`);
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

    // 5. Stop Tomcat
    step('Step 5/8 — Stopping Tomcat');
    try {
        runCmd(`${config.app_server.home}/bin/shutdown.sh 2>&1`, 15000);
        logDeploy('Shutdown signal sent');
    } catch {
        logDeploy('Shutdown script returned error (Tomcat may not be running)');
    }
    await waitForTomcatStop();

    // 6. Gradle build
    step('Step 6/8 — Gradle build');
    let incremental = false;
    logDeploy('Trying incremental build (devClasses + devLib + jar)...');
    try {
        const incCmd = config.build.commands.incremental || './gradlew devClasses devLib jar';
        const incOut = await execSyncDeploy(`cd "${GEO_DIR}" && ${incCmd} 2>&1`, deployEnv, 300000);
        logDeploy(lastLines(incOut, 5));
        incremental = true;
        logDeploy('Incremental build succeeded');
    } catch (e) {
        logDeploy(`Incremental build failed: ${lastLines(e.message, 5)}`);
        logDeploy('Falling back to full build...');
        try {
            const cleanCmd = config.build.commands.full_clean || './gradlew clean';
            const cleanOut = await execSyncDeploy(`cd "${GEO_DIR}" && ${cleanCmd} 2>&1`, deployEnv, 120000);
            logDeploy(lastLines(cleanOut, 3));
        } catch (e2) {
            throw new Error(`Gradle clean failed:\n${lastLines(e2.message, 15)}`);
        }
        try {
            const buildCmd = config.build.commands.full_build || './gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false';
            const buildOut = await execSyncDeploy(`cd "${GEO_DIR}" && ${buildCmd} 2>&1`, deployEnv, 600000);
            logDeploy(lastLines(buildOut, 5));
        } catch (e2) {
            const compileError = e2.message.match(/error:.*$/gm);
            let detail = lastLines(e2.message, 30);
            if (compileError) {
                detail = 'Compilation errors:\n' + compileError.join('\n') + '\n\n' + lastLines(e2.message, 10);
            }
            throw new Error(`Gradle build failed:\n${detail}`);
        }
    }

    // Verify build output
    const devDir = config.build.output.dev_dir || 'devBuild';
    const releaseDir = config.build.output.release_dir || 'build/release';
    const jarDir = config.build.output.jar_dir || 'build/libs';
    const jarName = config.build.output.jar_name || 'geowealth.jar';

    if (incremental) {
        if (!fs.existsSync(`${GEO_DIR}/${devDir}/lib`)) {
            throw new Error(`Incremental build output missing: ${devDir}/lib not found.`);
        }
        if (!fs.existsSync(`${GEO_DIR}/${jarDir}/${jarName}`)) {
            throw new Error(`Incremental build output missing: ${jarDir}/${jarName} not found.`);
        }
        const jarCount = runCmd(`ls "${GEO_DIR}/${devDir}/lib/"*.jar 2>/dev/null | wc -l`);
        logDeploy(`Incremental build: ${jarCount} dependency JAR(s) + ${jarName}`);
    } else {
        const buildDir = `${GEO_DIR}/${releaseDir}`;
        if (!fs.existsSync(`${buildDir}/lib`)) {
            throw new Error(`Build output missing: ${buildDir}/lib not found.\nGradle may have succeeded but produced no artifacts. Check build.gradle.`);
        }
        const jarCount = runCmd(`ls "${buildDir}/lib/"*.jar 2>/dev/null | wc -l`);
        logDeploy(`Full build produced ${jarCount} JAR(s)`);
    }

    // 7. Copy artifacts
    step('Step 7/8 — Copying artifacts');
    const agentConfigFile = config.agents ? config.agents.config_file : '';
    const libCopyCmd = incremental
        ? `mkdir -p "${BE_HOME}/lib" && cp -r ./${devDir}/lib/* "${BE_HOME}/lib/" && cp ./${jarDir}/${jarName} "${BE_HOME}/lib/"`
        : `cp -r ./${releaseDir}/lib "${BE_HOME}"`;
    try {
        await execSyncDeploy(`
            cd "${GEO_DIR}" &&
            rm -rf "${BE_HOME}/lib" "${BE_HOME}/bin" "${BE_HOME}/sbin" "${BE_HOME}/etc" "${BE_HOME}/dev_etc" \
                   "${BE_HOME}/birt_reports" "${BE_HOME}/profilers" "${BE_HOME}/templates" "${BE_HOME}/exports" \
                   "${BE_HOME}/WebContent" "${BE_HOME}/birt_platform" &&
            mkdir -p "${BE_HOME}/pids" "${BE_HOME}/logs" &&
            ${libCopyCmd} &&
            cp -r ./bin "${BE_HOME}" &&
            cp -r ./sbin "${BE_HOME}" &&
            cp -r ./birt_platform.tar.gz "${BE_HOME}" &&
            cp -r ./birt_reports "${BE_HOME}" &&
            cp -r ./dev_etc "${BE_HOME}" &&
            cp -r ./etc "${BE_HOME}" &&
            cp -r ./profilers "${BE_HOME}" &&
            cp -r ./templates "${BE_HOME}" &&
            cp -r ./exports "${BE_HOME}" &&
            cp -r ./WebContent "${BE_HOME}" &&
            cp "${agentConfigFile}" "${BE_HOME}/etc/" &&
            cp ./etc/*.properties "${BE_HOME}/etc/" &&
            cp ./src/main/resources/*.properties "${BE_HOME}/etc/" &&
            cp ./etc/hibernate-dbhost.properties "${BE_HOME}/etc/hibernate.properties" &&
            cp ./src/main/resources/*.xml "${BE_HOME}/etc/"
        `, deployEnv, 120000);
    } catch (e) {
        throw new Error(`Artifact copy failed:\n${e.message}\n\nCheck disk space: df -h /\nCheck permissions on ${BE_HOME}`);
    }
    logDeploy(`Artifacts copied to BEServer (${incremental ? 'incremental' : 'full'} build)`);

    // Inject billing agents
    const jrunFile = `${BE_HOME}/etc/jrunagents.xml`;
    if (!runCmd(`grep -l BillingManager "${jrunFile}" 2>/dev/null`)) {
        logDeploy('Injecting billing agents into jrunagents.xml...');
        try {
            await execSyncDeploy(`sed -i '/<\\/AGENTLIST>/i \\
   <AGENT alias="BillingManager">\\
      <TRAITLIST>\\
         <TRAIT class="com.geowealth.agent.billing.BillingManagerTrait" />\\
      </TRAITLIST>\\
   </AGENT>\\
\\
   <AGENT alias="BillingProcessManager">\\
      <TRAITLIST>\\
         <TRAIT class="com.geowealth.agent.billing.BillingProcessManagerTrait" />\\
      </TRAITLIST>\\
   </AGENT>\\
\\
   <AGENT alias="BillingSpecificationManager">\\
      <TRAITLIST>\\
         <TRAIT class="com.geowealth.agent.billingspecification.BillingSpecificationManagerTrait" />\\
      </TRAITLIST>\\
   </AGENT>' "${jrunFile}"`, deployEnv, 10000);
            logDeploy('Billing agents injected');
        } catch (e) {
            logDeploy(`WARNING: Could not inject billing agents: ${e.message}`);
        }
    } else {
        logDeploy('Billing agents already present in jrunagents.xml');
    }

    // Extract birt platform
    try {
        await execSyncDeploy(`cd "${BE_HOME}" && tar -xzf birt_platform.tar.gz`, deployEnv, 30000);
        logDeploy('BIRT platform extracted');
    } catch (e) {
        logDeploy(`WARNING: BIRT platform extraction failed: ${e.message}`);
    }

    // Copy WebContent to Tomcat
    const tomcatWebapps = `${config.app_server.home}/webapps/ROOT`;
    try {
        if (incremental) {
            await execSyncDeploy(`
                rm -rf "${tomcatWebapps}/"* &&
                cp -r "${GEO_DIR}/WebContent/"* "${tomcatWebapps}/" &&
                mkdir -p "${tomcatWebapps}/WEB-INF/lib" &&
                cp -r "${GEO_DIR}/${devDir}/lib/"* "${tomcatWebapps}/WEB-INF/lib/" &&
                cp "${GEO_DIR}/${jarDir}/${jarName}" "${tomcatWebapps}/WEB-INF/lib/"
            `, deployEnv, 30000);
            logDeploy(`WebContent deployed to Tomcat (incremental: source + ${devDir} JARs)`);
        } else {
            await execSyncDeploy(`rm -rf "${tomcatWebapps}/"* && cp -r "${GEO_DIR}/${releaseDir}/WebContent/"* "${tomcatWebapps}/"`, deployEnv, 30000);
            logDeploy('WebContent deployed to Tomcat (full build)');
        }
    } catch (e) {
        throw new Error(`Failed to copy WebContent to Tomcat:\n${e.message}\n\nCheck if ${tomcatWebapps} is writable.`);
    }

    fixCorruptedJars(config);

    // 8. Start Tomcat
    step('Step 8/8 — Starting Tomcat');
    try {
        await execSyncDeploy(`rm -f "${config.app_server.home}/catalina_pid.txt" && ${config.app_server.home}/bin/startup.sh 2>&1`, deployEnv, 15000);
        logDeploy('Tomcat startup initiated');
    } catch (e) {
        throw new Error(`Tomcat failed to start:\n${e.message}\n\nCheck catalina.out for details:\n  tail -50 ${config.app_server.home}/logs/catalina.out`);
    }

    // Wait for Tomcat
    logDeploy('Waiting for Tomcat to become available...');
    const startupCheck = config.deploy && config.deploy.startup_check ? config.deploy.startup_check : {};
    const maxAttempts = startupCheck.max_attempts || 30;
    const intervalMs = startupCheck.interval_ms || 2000;
    let tomcatOk = false;
    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, intervalMs));
        try {
            const code = runCmd(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${config.app_server.port}/ 2>/dev/null`);
            if (code === '200') {
                tomcatOk = true;
                break;
            }
            logDeploy(`Tomcat not ready yet (HTTP ${code})... retrying`);
        } catch { /* not ready */ }
    }
    if (tomcatOk) {
        logDeploy('Tomcat is UP and responding (HTTP 200)');
    } else {
        logDeploy(`WARNING: Tomcat did not respond with HTTP 200 after ${maxAttempts * intervalMs / 1000}s`);
        logDeploy(`Check logs: tail -100 ${config.app_server.home}/logs/catalina.out`);
    }

    const finalBranch = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    step(`Deploy complete — branch: ${finalBranch} — ${mins}m ${secs}s`);
}

function registerRoutes(app, config, deployEnv) {
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
            await runDeploy(config, deployEnv, branch);
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
            await runQuickDeploy(config, deployEnv, agents, restartTomcat);
        } catch (e) {
            logDeploy(`FAILED: ${e.message}`);
        } finally {
            deployInProgress = false;
        }
    });
}

module.exports = { isDeployInProgress, registerRoutes };
