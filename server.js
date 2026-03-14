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

function getTomcatStatus() {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(`http://localhost:${TOMCAT_PORT}/`, { timeout: 5000 }, (res) => {
            res.resume();
            const elapsed = Date.now() - start;
            const proc = getTomcatProcess();
            resolve({
                http_port: TOMCAT_PORT, http_code: res.statusCode,
                response_ms: elapsed, running: res.statusCode === 200,
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

// Restart Tomcat
app.post('/restart/tomcat', async (_req, res) => {
    try {
        console.log('[restart] Stopping Tomcat...');
        await runAsync(`${TOMCAT_BIN}/shutdown.sh 2>&1`, 30000).catch(() => {});
        // Wait for graceful stop, then force if needed
        await runAsync('sleep 5');
        const pid = runCmd("pgrep -f catalina.startup.Bootstrap");
        if (pid) {
            console.log(`[restart] Force killing Tomcat pid ${pid}`);
            await runAsync(`kill -9 ${pid} 2>/dev/null`).catch(() => {});
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
const DEPLOY_ENV = {
    ...process.env,
    JAVA_HOME,
    PATH: `${JAVA_HOME}/bin:${process.env.PATH}`,
    GEO_TEMPLATE_NAME: CONFIG_YML,
    GEO_ENV,
    GEO_SERVER,
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
    const step = (name) => logDeploy(`── ${name} ──`);

    // 1. Stash local changes
    step('Checking for local changes');
    const status = runCmd(`git -C "${GEO_DIR}" status --porcelain`);
    let stashed = false;
    if (status) {
        logDeploy('Stashing local changes...');
        runCmd(`git -C "${GEO_DIR}" stash push -u -m "deploy-${Date.now()}"`, 30000);
        stashed = true;
    } else {
        logDeploy('Working directory clean');
    }

    // 2. Checkout and pull branch
    step(`Switching to branch: ${branch}`);
    runCmd(`git -C "${GEO_DIR}" checkout "${branch}" 2>&1`, 30000);
    logDeploy('Pulling latest...');
    runCmd(`git -C "${GEO_DIR}" pull origin "${branch}" 2>&1`, 60000);

    // 3. Apply stash
    if (stashed) {
        step('Applying stashed changes');
        try {
            runCmd(`git -C "${GEO_DIR}" stash pop 2>&1`);
            logDeploy('Stash applied successfully');
        } catch {
            logDeploy('WARNING: Stash had conflicts, cleared. Apply manually: git stash pop');
            runCmd(`git -C "${GEO_DIR}" checkout -- . 2>/dev/null`);
        }
    }

    // 4. Stop Tomcat
    step('Stopping Tomcat');
    try { runCmd(`${TOMCAT_HOME}/bin/shutdown.sh 2>&1`, 15000); } catch { /* ok */ }
    await waitForTomcatStop();

    // 5. Gradle build
    step('Gradle clean + makebuild');
    logDeploy('Running ./gradlew clean...');
    const cleanOut = execSyncDeploy(`cd "${GEO_DIR}" && ./gradlew clean 2>&1`, 120000);
    logDeploy(lastLines(cleanOut, 3));

    logDeploy('Running ./gradlew makebuild...');
    const buildOut = execSyncDeploy(`cd "${GEO_DIR}" && ./gradlew makebuild -Pbuild_react=false -Pbuild_sencha=false 2>&1`, 600000);
    logDeploy(lastLines(buildOut, 5));

    // 6. Copy artifacts
    step('Copying artifacts');
    execSyncDeploy(`
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
    logDeploy('Artifacts copied');

    // Inject billing agents if needed
    const jrunFile = `${BE_HOME}/etc/jrunagents.xml`;
    if (!runCmd(`grep -l BillingManager "${jrunFile}" 2>/dev/null`)) {
        logDeploy('Injecting billing agents...');
        execSyncDeploy(`sed -i '/<\\/AGENTLIST>/i \\
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
    }

    // Extract birt platform & copy WebContent to Tomcat
    execSyncDeploy(`cd "${BE_HOME}" && tar -xzf birt_platform.tar.gz`, 30000);
    execSyncDeploy(`rm -rf "${TOMCAT_HOME}/webapps/ROOT/"* && cp -r "${GEO_DIR}/build/release/WebContent/"* "${TOMCAT_HOME}/webapps/ROOT/"`, 30000);
    logDeploy('WebContent deployed to Tomcat');

    // 7. Start Tomcat
    step('Starting Tomcat');
    execSyncDeploy(`rm -f "${TOMCAT_HOME}/catalina_pid.txt" && ${TOMCAT_HOME}/bin/startup.sh`, 15000);
    logDeploy('Tomcat started');

    const finalBranch = runCmd(`git -C "${GEO_DIR}" rev-parse --abbrev-ref HEAD`);
    step(`Deploy complete — branch: ${finalBranch}`);
}

function execSyncDeploy(cmd, timeout = 120000) {
    try {
        return execSync(cmd, { timeout, encoding: 'utf8', env: DEPLOY_ENV }).trim();
    } catch (e) {
        throw new Error(e.stderr || e.stdout || e.message);
    }
}

function lastLines(str, n) {
    if (!str) return '';
    const lines = str.split('\n');
    return lines.slice(-n).join('\n');
}

async function waitForTomcatStop() {
    const pid = runCmd("pgrep -f catalina.startup.Bootstrap | head -1");
    if (!pid) { logDeploy('Tomcat was not running'); return; }
    logDeploy(`Waiting for Tomcat (PID ${pid}) to stop...`);
    for (let i = 0; i < 30; i++) {
        if (!runCmd(`kill -0 ${pid} 2>/dev/null && echo alive`)) {
            logDeploy('Tomcat stopped');
            return;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    logDeploy('Force killing Tomcat...');
    runCmd(`kill -9 ${pid} 2>/dev/null`);
    await new Promise(r => setTimeout(r, 1000));
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Status API listening on :${PORT}`);
});
