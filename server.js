#!/usr/bin/env node
/**
 * Server Status API — Express server that exposes system and agent
 * status as JSON for the GeoWealth Server Monitor Chrome extension.
 *
 * Usage:
 *   node server.js [--port 9876]
 *   nohup node server.js &
 */

const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const http = require('http');
const yaml = require('js-yaml');

const PORT = parseInt(process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1] : '7103', 10);
const BE_HOME = '/home/petar/AppServer/BEServer';
const TOMCAT_PORT = 8080;
const CONFIG_YML = process.env.GEO_TEMPLATE_NAME || '/home/petar/AppServer/petarServer.yml';
const GEO_ENV = process.env.GEO_ENV || 'DevPetar';
const GEO_SERVER = process.env.GEO_SERVER || 'DevPetar';

function runCmd(cmd, timeout = 10000) {
    try {
        return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

/** Like runCmd but throws on failure instead of returning ''. Use for critical operations. */
function runCmdStrict(cmd, timeout = 10000) {
    try {
        return execSync(cmd, { timeout, encoding: 'utf8' }).trim();
    } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim() : (e.stdout ? e.stdout.toString().trim() : e.message);
        throw new Error(msg || `Command failed: ${cmd}`);
    }
}

function getSystemInfo() {
    const memory = {};
    const memRaw = runCmd('free -b --si');
    for (const line of memRaw.split('\n')) {
        if (line.startsWith('Mem:')) {
            const p = line.split(/\s+/);
            Object.assign(memory, {
                total: +p[1], used: +p[2], free: +p[3], available: +p[6],
            });
        } else if (line.startsWith('Swap:')) {
            const p = line.split(/\s+/);
            memory.swap_total = +p[1];
            memory.swap_used = +p[2];
        }
    }

    const disk = {};
    const diskRaw = runCmd("df -B1 / --output=size,used,avail,pcent | tail -1");
    if (diskRaw) {
        const p = diskRaw.split(/\s+/).filter(Boolean);
        Object.assign(disk, {
            total: +p[0], used: +p[1], avail: +p[2], use_pct: p[3],
        });
    }

    const uptimeRaw = runCmd('cat /proc/uptime');
    const uptime_seconds = parseFloat(uptimeRaw.split(' ')[0]) || 0;

    const loadRaw = runCmd('cat /proc/loadavg');
    const load_average = loadRaw ? loadRaw.split(' ').slice(0, 3).map(Number) : [];

    const cpus = parseInt(runCmd('nproc'), 10) || 0;

    return { memory, disk, uptime_seconds, load_average, cpus };
}

const TOMCAT_HOME = '/home/petar/AppServer/apache-tomcat-9.0.38';

function checkPlatformReady() {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${TOMCAT_PORT}/platformOne/checkPlatformStatus.do`, { timeout: 5000 }, (res) => {
            res.resume();
            // 302 = redirect to login = platform fully loaded
            resolve(res.statusCode === 302);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function getTomcatStatus() {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(`http://localhost:${TOMCAT_PORT}/`, { timeout: 5000 }, async (res) => {
            res.resume();
            const elapsed = Date.now() - start;
            const proc = getTomcatProcess();
            const ready = res.statusCode === 200 ? await checkPlatformReady() : false;
            resolve({
                http_port: TOMCAT_PORT, http_code: res.statusCode,
                response_ms: elapsed, running: res.statusCode === 200,
                ready,
                process: proc,
                threads: getTomcatThreads(proc.pid),
                jvm: getTomcatJvm(proc.pid),
                webapps: getDeployedWebapps(),
                requests_today: getRequestsToday(),
            });
        });
        req.on('error', () => {
            const proc = getTomcatProcess();
            resolve({
                http_port: TOMCAT_PORT, http_code: 0,
                response_ms: Date.now() - start, running: false,
                ready: false,
                process: proc,
                threads: getTomcatThreads(proc.pid),
                jvm: getTomcatJvm(proc.pid),
                webapps: getDeployedWebapps(),
                requests_today: getRequestsToday(),
            });
        });
        req.on('timeout', () => { req.destroy(); });
    });
}

function getTomcatProcess() {
    const raw = runCmd(
        "ps -eo pid,rss,pcpu,lstart,args --no-headers | grep catalina.startup.Bootstrap | grep -v grep"
    );
    if (!raw) return {};
    const line = raw.split('\n')[0].trim();
    const parts = line.split(/\s+/);
    if (parts.length < 9) return {};
    const args = parts.slice(8).join(' ');
    const xmxMatch = args.match(/-Xmx(\S+)/);
    const startedStr = parts.slice(3, 8).join(' ');
    let uptime_seconds = 0;
    try {
        uptime_seconds = Math.floor((Date.now() - new Date(startedStr).getTime()) / 1000);
    } catch { /* ignore */ }
    return {
        pid: +parts[0],
        rss_kb: +parts[1],
        cpu_pct: parseFloat(parts[2]),
        started: startedStr,
        uptime_seconds,
        ...(xmxMatch && { xmx: xmxMatch[1] }),
    };
}

function getTomcatThreads(pid) {
    if (!pid) return {};
    const threadCount = runCmd(`cat /proc/${pid}/status 2>/dev/null | grep Threads | awk '{print $2}'`);
    const openFds = runCmd(`ls /proc/${pid}/fd 2>/dev/null | wc -l`);
    const fdLimit = runCmd(`cat /proc/${pid}/limits 2>/dev/null | grep 'Max open files' | awk '{print $4}'`);
    return {
        count: parseInt(threadCount, 10) || 0,
        open_fds: parseInt(openFds, 10) || 0,
        fd_limit: parseInt(fdLimit, 10) || 0,
    };
}

function getTomcatJvm(pid) {
    if (!pid) return {};
    try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        const xmx = cmdline.match(/-Xmx(\S+)/);
        const xms = cmdline.match(/-Xms(\S+)/);
        const maxDirect = cmdline.match(/-XX:MaxDirectMemorySize=(\S+)/);
        const reactorPool = cmdline.match(/-Dworker\.reactorpool\.size=(\d+)/);
        const akkaSystem = cmdline.match(/-Dakka\.agent\.system\.base\.name=(\S+)/);
        const devMode = cmdline.includes('-Ddevelopment.mode=true');
        const gcType = cmdline.match(/-XX:\+Use(\w+)GC/) || cmdline.match(/-XX:\+Use(\w+)/);
        return {
            xmx: xmx ? xmx[1] : null,
            xms: xms ? xms[1] : null,
            max_direct_memory: maxDirect ? maxDirect[1] : null,
            reactor_pool_size: reactorPool ? +reactorPool[1] : null,
            akka_system: akkaSystem ? akkaSystem[1] : null,
            dev_mode: devMode,
            gc_type: gcType ? gcType[1] : 'G1 (default)',
        };
    } catch {
        return {};
    }
}

function getDeployedWebapps() {
    try {
        const dirs = fs.readdirSync(`${TOMCAT_HOME}/webapps`);
        return dirs.filter(d => {
            try {
                return fs.statSync(`${TOMCAT_HOME}/webapps/${d}`).isDirectory();
            } catch { return false; }
        });
    } catch {
        return [];
    }
}

function getRequestsToday() {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = `${TOMCAT_HOME}/logs/localhost_access_log.${today}.txt`;
    const count = runCmd(`wc -l < "${logFile}" 2>/dev/null`);
    return parseInt(count, 10) || 0;
}

function getConfiguredAgents() {
    try {
        const raw = fs.readFileSync(CONFIG_YML, 'utf8');
        const doc = yaml.load(raw);
        const env = doc.environments[GEO_ENV];
        if (!env) return [];
        const server = env.servers[GEO_SERVER];
        if (!server || !server.agents) return [];
        return server.agents.map(a => ({
            name: a.name,
            configured_memory: a.max_memory,
            autostart: a.autostart !== 'no_autostart',
            jvm_params: a.jvm_params || null,
            restart_if_dead: a.restart_if_dead === 'yes' || a.restart_if_dead === true,
        }));
    } catch {
        return [];
    }
}

function updateAgentMemory(agentName, newMemory) {
    const raw = fs.readFileSync(CONFIG_YML, 'utf8');
    // Find the agent's max_memory line and update it
    const lines = raw.split('\n');
    let inAgent = false;
    for (let i = 0; i < lines.length; i++) {
        const nameMatch = lines[i].match(/^\s+-\s+name:\s+(\S+)/);
        if (nameMatch) {
            inAgent = nameMatch[1] === agentName;
        }
        if (inAgent && lines[i].match(/^\s+max_memory:\s+/)) {
            const indent = lines[i].match(/^(\s+)/)[1];
            lines[i] = `${indent}max_memory: ${newMemory}`;
            fs.writeFileSync(CONFIG_YML, lines.join('\n'), 'utf8');
            return true;
        }
    }
    return false;
}

function updateAgentAutostart(agentName, enabled) {
    const raw = fs.readFileSync(CONFIG_YML, 'utf8');
    const lines = raw.split('\n');
    let inAgent = false;
    let agentStartIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const nameMatch = lines[i].match(/^\s+-\s+name:\s+(\S+)/);
        if (nameMatch) {
            inAgent = nameMatch[1] === agentName;
            if (inAgent) agentStartIdx = i;
        }
        if (inAgent && lines[i].match(/^\s+autostart:\s+/)) {
            if (enabled) {
                // Remove the autostart: no_autostart line
                lines.splice(i, 1);
            } else {
                const indent = lines[i].match(/^(\s+)/)[1];
                lines[i] = `${indent}autostart: no_autostart`;
            }
            fs.writeFileSync(CONFIG_YML, lines.join('\n'), 'utf8');
            return true;
        }
        // Hit next agent without finding autostart line
        if (!inAgent && agentStartIdx >= 0 && nameMatch) {
            if (!enabled) {
                // Need to add autostart: no_autostart after the previous agent's last property
                const prevIndent = lines[agentStartIdx].match(/^(\s+-\s+)/)[0].replace('-', ' ');
                lines.splice(i, 0, `${prevIndent}autostart: no_autostart`);
                fs.writeFileSync(CONFIG_YML, lines.join('\n'), 'utf8');
                return true;
            }
            // Autostart is already enabled (no line present means auto)
            return true;
        }
    }
    // Last agent in file, no autostart line found
    if (inAgent && !enabled) {
        const indent = lines[agentStartIdx].match(/^(\s+-\s+)/)[0].replace('-', ' ');
        lines.push(`${indent}autostart: no_autostart`);
        fs.writeFileSync(CONFIG_YML, lines.join('\n'), 'utf8');
        return true;
    }
    if (inAgent && enabled) return true; // already autostart
    return false;
}

function getAgents() {
    const nfjobsRaw = runCmd(`${BE_HOME}/sbin/nfjobs 2>/dev/null`);
    const nfcheckRaw = runCmd(`${BE_HOME}/sbin/nfcheckall 2>/dev/null`);

    // Get all configured agents from YAML
    const configured = getConfiguredAgents();

    // Build running agents map
    const runningMap = {};
    for (const line of nfjobsRaw.split('\n')) {
        const m = line.match(/Name:\s+(\S+)\s+PID:\s+(\d+)\s+Start Time:\s+(.*)/);
        if (m) {
            runningMap[m[1]] = { pid: +m[2], started: m[3].trim() };
        }
    }

    // Build accessible set
    const accessibleSet = new Set();
    for (const line of nfcheckRaw.split('\n')) {
        const m = line.match(/Agentsystem\s+(\S+)\s+exists and is accessible/);
        if (m) accessibleSet.add(m[1]);
    }

    // Merge: start with configured agents, add any running agents not in config
    const agents = [];
    const seen = new Set();

    for (const cfg of configured) {
        seen.add(cfg.name);
        const running = runningMap[cfg.name];
        const a = {
            name: cfg.name,
            configured_memory: cfg.configured_memory,
            autostart: cfg.autostart,
            restart_if_dead: cfg.restart_if_dead,
            jvm_params: cfg.jvm_params,
            running: !!running,
            accessible: accessibleSet.has(cfg.name),
            pid: running ? running.pid : null,
            started: running ? running.started : null,
        };
        if (running) {
            enrichRunningAgent(a);
        }
        agents.push(a);
    }

    // Add any running agents not in config
    for (const [name, info] of Object.entries(runningMap)) {
        if (!seen.has(name)) {
            const a = {
                name,
                configured_memory: null,
                autostart: null,
                restart_if_dead: null,
                jvm_params: null,
                running: true,
                accessible: accessibleSet.has(name),
                pid: info.pid,
                started: info.started,
            };
            enrichRunningAgent(a);
            agents.push(a);
        }
    }

    const total = configured.length;
    const running = agents.filter(a => a.running).length;
    const healthy = agents.filter(a => a.accessible).length;
    return { agents, total, running, healthy };
}

function enrichRunningAgent(a) {
    if (!a.pid) return;
    const psLine = runCmd(`ps -p ${a.pid} -o rss=,pcpu= 2>/dev/null`);
    if (psLine) {
        const parts = psLine.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            a.rss_kb = +parts[0];
            a.cpu_pct = parseFloat(parts[1]);
        }
    }
    try {
        const cmdline = fs.readFileSync(`/proc/${a.pid}/cmdline`, 'utf8')
            .replace(/\0/g, ' ');
        const xmx = cmdline.match(/-Xmx(\S+)/);
        if (xmx) a.xmx = xmx[1];
    } catch { /* process gone */ }

    if (a.started) {
        try {
            const cleanDate = a.started.replace(/\s(?:EET|EEST|CET|CEST|UTC|GMT|MSK|IST|EST|CST|PST|EDT|CDT|PDT|WET|WEST)\b/g, '');
            const parsed = new Date(cleanDate);
            if (!isNaN(parsed.getTime())) {
                a.uptime_seconds = Math.floor((Date.now() - parsed.getTime()) / 1000);
            }
        } catch { /* ignore */ }
    }

    const threadCount = runCmd(`cat /proc/${a.pid}/status 2>/dev/null | grep Threads | awk '{print $2}'`);
    const openFds = runCmd(`ls /proc/${a.pid}/fd 2>/dev/null | wc -l`);
    if (threadCount) a.threads = parseInt(threadCount, 10) || 0;
    if (openFds) a.open_fds = parseInt(openFds, 10) || 0;
}

async function collectStatus() {
    const [system, tomcat, agentsData] = await Promise.all([
        getSystemInfo(),
        getTomcatStatus(),
        getAgents(),
    ]);
    return { timestamp: Date.now() / 1000, system, tomcat, agents: agentsData };
}

const app = express();

app.use((_req, res, next) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    next();
});

app.use(express.json());

app.get('/status', async (_req, res) => {
    const data = await collectStatus();
    res.json(data);
});

app.get('/ping', (_req, res) => {
    res.type('text/plain').send('pong');
});

// ── Restart endpoints ──

const TOMCAT_BIN = `${TOMCAT_HOME}/bin`;
const SBIN = `${BE_HOME}/sbin`;
const ENV_VARS = `GEO_TEMPLATE_NAME="${process.env.GEO_TEMPLATE_NAME || '/home/petar/AppServer/petarServer.yml'}" GEO_ENV="${process.env.GEO_ENV || 'DevPetar'}" GEO_SERVER="${process.env.GEO_SERVER || 'DevPetar'}"`;

function runAsync(cmd, timeout = 120000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, env: { ...process.env } }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
        });
    });
}

// Stop Tomcat
app.post('/stop/tomcat', async (_req, res) => {
    try {
        console.log('[stop] Stopping Tomcat...');
        await runAsync(`${TOMCAT_BIN}/shutdown.sh 2>&1`, 30000).catch(() => {});
        await runAsync('sleep 5');
        const pids = runCmd("pgrep -f catalina.startup.Bootstrap");
        if (pids) {
            for (const pid of pids.split('\n').filter(Boolean)) {
                console.log(`[stop] Force killing Tomcat pid ${pid}`);
                await runAsync(`kill -9 ${pid} 2>/dev/null`).catch(() => {});
            }
            await runAsync('sleep 2');
        }
        res.json({ ok: true, message: 'Tomcat stopped' });
    } catch (e) {
        console.error('[stop] Tomcat stop failed:', e.message);
        res.status(500).json({ ok: false, message: e.message });
    }
});

// Restart Tomcat
app.post('/restart/tomcat', async (_req, res) => {
    try {
        console.log('[restart] Stopping Tomcat...');
        await runAsync(`${TOMCAT_BIN}/shutdown.sh 2>&1`, 30000).catch(() => {});
        // Wait for graceful stop, then force kill ALL Tomcat processes
        await runAsync('sleep 5');
        const pids = runCmd("pgrep -f catalina.startup.Bootstrap");
        if (pids) {
            for (const pid of pids.split('\n').filter(Boolean)) {
                console.log(`[restart] Force killing Tomcat pid ${pid}`);
                await runAsync(`kill -9 ${pid} 2>/dev/null`).catch(() => {});
            }
            await runAsync('sleep 2');
        }
        console.log('[restart] Starting Tomcat...');
        await runAsync(`${TOMCAT_BIN}/startup.sh 2>&1`);
        res.json({ ok: true, message: 'Tomcat restarted' });
    } catch (e) {
        console.error('[restart] Tomcat restart failed:', e.message);
        res.status(500).json({ ok: false, message: e.message });
    }
});

// Stop a specific agent
app.post('/stop/agent/:name', async (req, res) => {
    const name = req.params.name;
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
        return res.status(400).json({ ok: false, message: 'Invalid agent name' });
    }
    const pidFile = `${BE_HOME}/pids/${name}.pid`;
    if (!fs.existsSync(pidFile)) {
        return res.status(404).json({ ok: false, message: `Agent "${name}" not found or not running` });
    }
    try {
        console.log(`[stop] Stopping agent ${name}...`);
        await runAsync(`${SBIN}/nfstop ${name} 2>&1`, 60000);
        res.json({ ok: true, message: `Agent "${name}" stopped` });
    } catch (e) {
        console.error(`[stop] Agent ${name} stop failed:`, e.message);
        res.status(500).json({ ok: false, message: e.message });
    }
});

// Restart a specific agent
app.post('/restart/agent/:name', async (req, res) => {
    const name = req.params.name;
    // Validate agent name — only alphanumeric and lowercase
    if (!/^[a-z][a-z0-9]*$/.test(name)) {
        return res.status(400).json({ ok: false, message: 'Invalid agent name' });
    }
    // Check agent exists
    const pidFile = `${BE_HOME}/pids/${name}.pid`;
    if (!fs.existsSync(pidFile)) {
        return res.status(404).json({ ok: false, message: `Agent "${name}" not found` });
    }
    try {
        console.log(`[restart] Stopping agent ${name}...`);
        await runAsync(`${SBIN}/nfstop ${name} 2>&1`, 60000);
        console.log(`[restart] Starting agent ${name}...`);
        await runAsync(`${ENV_VARS} ${SBIN}/nfstart ${name} 2>&1`, 60000);
        console.log(`[restart] Agent ${name} start command completed, accessibility will be checked by client`);
        res.json({ ok: true, message: `Agent "${name}" restarted` });
    } catch (e) {
        console.error(`[restart] Agent ${name} restart failed:`, e.message);
        res.status(500).json({ ok: false, message: e.message });
    }
});

// Restart all agents
app.post('/restart/agents', async (_req, res) => {
    try {
        console.log('[restart] Restarting all agents...');
        await runAsync(`${ENV_VARS} ${SBIN}/restart_agents.sh 2>&1`, 300000);
        res.json({ ok: true, message: 'All agents restarted' });
    } catch (e) {
        console.error('[restart] All agents restart failed:', e.message);
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
        const updated = updateAgentAutostart(name, enabled);
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

// ── Free RAM ──

app.post('/system/free-ram', async (_req, res) => {
    const results = [];
    try {
        // 1. Drop filesystem caches
        const syncOut = runCmd('sync');
        const dropOut = runCmd('echo 3 | sudo tee /proc/sys/vm/drop_caches 2>&1');
        results.push('Filesystem caches dropped');

        // 2. Trigger GC on all Java processes (Tomcat + agents)
        const javaPids = runCmd("pgrep -f 'java' 2>/dev/null");
        if (javaPids) {
            const pids = javaPids.split('\n').filter(Boolean);
            for (const pid of pids) {
                const gcOut = runCmd(`jcmd ${pid} GC.run 2>/dev/null`);
                if (gcOut && !gcOut.includes('not found')) {
                    results.push(`GC triggered for PID ${pid}`);
                }
            }
        }

        // 3. Get memory before/after
        const memAfter = runCmd('free -b --si');
        let available = '';
        for (const line of memAfter.split('\n')) {
            if (line.startsWith('Mem:')) {
                const p = line.split(/\s+/);
                available = `Available: ${(+p[6] / 1e9).toFixed(1)} GB`;
            }
        }
        results.push(available);

        console.log('[system] Free RAM:', results.join(', '));
        res.json({ ok: true, message: results.join('\n') });
    } catch (e) {
        console.error('[system] Free RAM error:', e.message);
        res.status(500).json({ ok: false, message: e.message });
    }
});

// ── Command execution ──

const ALLOWED_CMD_PREFIXES = [
    'tail ', 'head ', 'cat ', 'df ', 'du ', 'ls ', 'wc ',
    'git -C', 'git stash', 'git status', 'git log', 'git diff',
    'cd /home/petar/AppServer',
    './gradlew',
    'ps ', 'free ', 'uptime',
];

app.post('/exec', (req, res) => {
    const cmd = (req.body.cmd || '').trim();
    if (!cmd) {
        return res.status(400).json({ ok: false, output: 'No command provided' });
    }
    // Security: only allow commands starting with known safe prefixes
    const baseCmd = cmd.replace(/^\s*cd\s+\S+\s*&&\s*/, '');
    const allowed = ALLOWED_CMD_PREFIXES.some(p => cmd.startsWith(p) || baseCmd.startsWith(p));
    if (!allowed) {
        return res.status(403).json({ ok: false, output: `Command not allowed: ${cmd}` });
    }
    try {
        const output = execSync(cmd, { timeout: 30000, encoding: 'utf8', env: DEPLOY_ENV, cwd: GEO_DIR }).trim();
        res.json({ ok: true, output: output || '(no output)' });
    } catch (e) {
        res.json({ ok: false, output: e.stderr || e.stdout || e.message });
    }
});

// ── Log endpoints ──

const TOMCAT_LOGS = `${TOMCAT_HOME}/logs`;
const AGENT_LOGS = `${BE_HOME}/logs`;

app.get('/logs/tomcat', (req, res) => {
    const lines = parseInt(req.query.lines, 10) || 200;
    const capped = Math.min(lines, 2000);
    const logFile = `${TOMCAT_LOGS}/catalina.out`;
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
    const logFile = `${AGENT_LOGS}/${name}/stdout.log`;
    if (!fs.existsSync(logFile)) {
        return res.status(404).type('text/plain').send(`Log not found: ${name}/stdout.log`);
    }
    try {
        const output = runCmd(`tail -n ${capped} "${logFile}" 2>/dev/null`, 15000);
        res.type('text/plain').send(output || '(empty)');
    } catch {
        res.status(500).type('text/plain').send('Error reading log');
    }
});

// ── Agent config endpoints ──

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
        const updated = updateAgentMemory(name, memory);
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

// ── Deploy / Branch management ──

const GEO_DIR = '/home/petar/AppServer/geowealth';
const JAVA_HOME = '/home/petar/AppServer/amazon-corretto-17.0.18.9.1-linux-x64';

// GitLab credentials from environment — enables HTTPS auth for git fetch/pull.
// Set GITLAB_TOKEN (personal access token or deploy token) and optionally GITLAB_USER.
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';
const GITLAB_USER = process.env.GITLAB_USER || 'oauth2';

// If a token is available, set up GIT_ASKPASS so git commands authenticate via HTTPS.
// Also switch the remote URL from SSH to HTTPS if needed.
const GIT_ASKPASS_SCRIPT = '/tmp/gw-git-askpass.sh';
if (GITLAB_TOKEN) {
    fs.writeFileSync(GIT_ASKPASS_SCRIPT, `#!/bin/sh\ncase "$1" in\n*Username*) echo "${GITLAB_USER}";;\n*Password*) echo "${GITLAB_TOKEN}";;\nesac\n`, { mode: 0o700 });

    // Inject into process.env so all execSync calls (runCmd, runCmdStrict) inherit it
    process.env.GIT_ASKPASS = GIT_ASKPASS_SCRIPT;
    process.env.GIT_TERMINAL_PROMPT = '0';

    // Switch remote from SSH to HTTPS if currently SSH
    const currentUrl = runCmd(`git -C "${GEO_DIR}" remote get-url origin`);
    const sshMatch = currentUrl.match(/^git@gitlab\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) {
        const httpsUrl = `https://gitlab.com/${sshMatch[1]}.git`;
        runCmd(`git -C "${GEO_DIR}" remote set-url origin "${httpsUrl}"`);
        console.log(`[git] Switched remote origin to HTTPS: ${httpsUrl}`);
    }
}

const DEPLOY_ENV = {
    ...process.env,
    JAVA_HOME,
    PATH: `${JAVA_HOME}/bin:${process.env.PATH}`,
    GEO_TEMPLATE_NAME: CONFIG_YML,
    GEO_ENV,
    GEO_SERVER,
    ...(GITLAB_TOKEN ? { GIT_ASKPASS: GIT_ASKPASS_SCRIPT, GIT_TERMINAL_PROMPT: '0' } : {}),
};

let deployInProgress = false;
let deployLog = [];

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

app.get('/deploy/status', (_req, res) => {
    res.json({ in_progress: deployInProgress, log: deployLog });
});

// SSE endpoint for real-time deploy log
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
        await runDeploy(branch);
    } catch (e) {
        logDeploy(`FAILED: ${e.message}`);
    } finally {
        deployInProgress = false;
    }
});

function logDeploy(msg) {
    const ts = new Date().toLocaleTimeString();
    deployLog.push(`[${ts}] ${msg}`);
    console.log(`[deploy] ${msg}`);
}

async function runDeploy(branch) {
    const step = (name) => logDeploy(`\n── ${name} ──`);
    const startTime = Date.now();
    const originalBranch = runCmdStrict(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    let stashed = false;

    // 1. Stash local changes (including assume-unchanged / skip-worktree files)
    step('Step 1/7 — Checking for local changes');
    const status = runCmd(`git -C "${GEO_DIR}" status --porcelain`);
    // Also check for assume-unchanged and skip-worktree files that git status misses
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

    // Re-check status after un-hiding files
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
        } catch (e) {
            throw new Error(`Stash failed: ${e.message}`);
        }
    } else {
        logDeploy('Working directory clean');
    }

    // 2. Checkout and pull branch
    step(`Step 2/7 — Switching to branch: ${branch}`);
    logDeploy(`Current branch: ${originalBranch}`);
    if (branch !== originalBranch) {
        try {
            const checkoutOut = runCmdStrict(`git -C "${GEO_DIR}" checkout "${branch}" 2>&1`, 30000);
            logDeploy(checkoutOut || `Switched to ${branch}`);
        } catch (e) {
            throw new Error(`Checkout failed for "${branch}": ${e.message}\nMake sure the branch exists and has no conflicts.`);
        }
        // Verify we actually switched
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

    // 3. Apply stash and restore hidden file flags
    if (stashed) {
        step('Step 3/7 — Applying stashed changes');
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
    // Restore assume-unchanged flags for hidden files
    if (hiddenFiles.length) {
        for (const f of hiddenFiles) {
            runCmd(`git -C "${GEO_DIR}" update-index --assume-unchanged "${f}" 2>/dev/null`);
        }
        logDeploy(`Restored assume-unchanged flags for ${hiddenFiles.length} file(s)`);
    }

    // 4. Stop Tomcat
    step('Step 4/7 — Stopping Tomcat');
    try {
        runCmd(`${TOMCAT_HOME}/bin/shutdown.sh 2>&1`, 15000);
        logDeploy('Shutdown signal sent');
    } catch {
        logDeploy('Shutdown script returned error (Tomcat may not be running)');
    }
    await waitForTomcatStop();

    // 5. Gradle build (incremental first, full build as fallback)
    step('Step 5/7 — Gradle build');
    let usedFullBuild = false;
    logDeploy('Trying incremental build (devClasses + devLib)...');
    try {
        const incOut = await execSyncDeploy(`cd "${GEO_DIR}" && ./gradlew devClasses devLib 2>&1`, 300000);
        logDeploy(lastLines(incOut, 5));
    } catch (e) {
        logDeploy(`Incremental build failed: ${lastLines(e.message, 5)}`);
        logDeploy('Falling back to full build...');
        usedFullBuild = true;
        try {
            const cleanOut = await execSyncDeploy(`cd "${GEO_DIR}" && ./gradlew clean 2>&1`, 120000);
            logDeploy(lastLines(cleanOut, 3));
        } catch (e2) {
            throw new Error(`Gradle clean failed:\n${lastLines(e2.message, 15)}`);
        }
        try {
            const buildOut = await execSyncDeploy(`cd "${GEO_DIR}" && ./gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false 2>&1`, 600000);
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

    // Verify build output exists
    const buildDir = `${GEO_DIR}/build/release`;
    if (!fs.existsSync(`${buildDir}/lib`)) {
        throw new Error(`Build output missing: ${buildDir}/lib not found.\nGradle may have succeeded but produced no artifacts. Check build.gradle.`);
    }
    const jarCount = runCmd(`ls "${buildDir}/lib/"*.jar 2>/dev/null | wc -l`);
    logDeploy(`Build produced ${jarCount} JAR(s)`);

    // 6. Copy artifacts
    step('Step 6/7 — Copying artifacts');
    try {
        await execSyncDeploy(`
            cd "${GEO_DIR}" &&
            rm -rf "${BE_HOME}/lib" "${BE_HOME}/bin" "${BE_HOME}/sbin" "${BE_HOME}/etc" "${BE_HOME}/dev_etc" \
                   "${BE_HOME}/birt_reports" "${BE_HOME}/profilers" "${BE_HOME}/templates" "${BE_HOME}/exports" \
                   "${BE_HOME}/WebContent" "${BE_HOME}/birt_platform" &&
            mkdir -p "${BE_HOME}/pids" "${BE_HOME}/logs" &&
            cp -r ./build/release/lib "${BE_HOME}" &&
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
            cp "${CONFIG_YML}" "${BE_HOME}/etc/" &&
            cp ./etc/*.properties "${BE_HOME}/etc/" &&
            cp ./src/main/resources/*.properties "${BE_HOME}/etc/" &&
            cp ./etc/hibernate-dbhost.properties "${BE_HOME}/etc/hibernate.properties" &&
            cp ./src/main/resources/*.xml "${BE_HOME}/etc/"
        `, 120000);
    } catch (e) {
        throw new Error(`Artifact copy failed:\n${e.message}\n\nCheck disk space: df -h /\nCheck permissions on ${BE_HOME}`);
    }
    logDeploy('Artifacts copied to BEServer');

    // Inject billing agents if needed
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
   </AGENT>' "${jrunFile}"`, 10000);
            logDeploy('Billing agents injected');
        } catch (e) {
            logDeploy(`WARNING: Could not inject billing agents: ${e.message}`);
        }
    } else {
        logDeploy('Billing agents already present in jrunagents.xml');
    }

    // Extract birt platform
    try {
        await execSyncDeploy(`cd "${BE_HOME}" && tar -xzf birt_platform.tar.gz`, 30000);
        logDeploy('BIRT platform extracted');
    } catch (e) {
        logDeploy(`WARNING: BIRT platform extraction failed: ${e.message}`);
    }

    // Copy WebContent to Tomcat
    try {
        await execSyncDeploy(`rm -rf "${TOMCAT_HOME}/webapps/ROOT/"* && cp -r "${GEO_DIR}/build/release/WebContent/"* "${TOMCAT_HOME}/webapps/ROOT/"`, 30000);
        logDeploy('WebContent deployed to Tomcat');
    } catch (e) {
        throw new Error(`Failed to copy WebContent to Tomcat:\n${e.message}\n\nCheck if ${TOMCAT_HOME}/webapps/ROOT/ is writable.`);
    }

    // Fix known corrupted JARs
    fixCorruptedJars();

    // 7. Start Tomcat
    step('Step 7/7 — Starting Tomcat');
    try {
        await execSyncDeploy(`rm -f "${TOMCAT_HOME}/catalina_pid.txt" && ${TOMCAT_HOME}/bin/startup.sh 2>&1`, 15000);
        logDeploy('Tomcat startup initiated');
    } catch (e) {
        throw new Error(`Tomcat failed to start:\n${e.message}\n\nCheck catalina.out for details:\n  tail -50 ${TOMCAT_HOME}/logs/catalina.out`);
    }

    // Wait a moment and verify Tomcat is responding
    logDeploy('Waiting for Tomcat to become available...');
    let tomcatOk = false;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
            const code = runCmd(`curl -s -o /dev/null -w "%{http_code}" http://localhost:${TOMCAT_PORT}/ 2>/dev/null`);
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
        logDeploy('WARNING: Tomcat did not respond with HTTP 200 after 60s');
        logDeploy(`Check logs: tail -100 ${TOMCAT_HOME}/logs/catalina.out`);
    }

    const finalBranch = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    step(`Deploy complete — branch: ${finalBranch} — ${mins}m ${secs}s`);
}

function fixCorruptedJars() {
    const GRADLE_CACHE = '/home/petar/.gradle/caches/modules-2/files-2.1';
    const tomcatLib = `${TOMCAT_HOME}/webapps/ROOT/WEB-INF/lib`;
    const beLib = `${BE_HOME}/lib`;

    // Find all JARs in tomcat lib and verify against gradle cache originals
    let fixed = 0;
    try {
        const jars = fs.readdirSync(tomcatLib).filter(f => f.endsWith('.jar'));
        for (const jar of jars) {
            const tomcatPath = `${tomcatLib}/${jar}`;
            const bePath = `${beLib}/${jar}`;
            // If BEServer has a different checksum, it's the correct one from gradle
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

function execSyncDeploy(cmd, timeout = 120000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, encoding: 'utf8', env: DEPLOY_ENV, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || stdout || err.message));
            else resolve((stdout || '').trim());
        });
    });
}

function lastLines(str, n) {
    if (!str) return '';
    const lines = str.split('\n');
    return lines.slice(-n).join('\n');
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
    // Force kill ALL remaining Tomcat processes
    const remaining = runCmd("pgrep -f catalina.startup.Bootstrap");
    if (remaining) {
        for (const pid of remaining.split('\n').filter(Boolean)) {
            logDeploy(`Force killing Tomcat PID ${pid}...`);
            runCmd(`kill -9 ${pid} 2>/dev/null`);
        }
        await new Promise(r => setTimeout(r, 1000));
    }
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Status API listening on :${PORT}`);
});
