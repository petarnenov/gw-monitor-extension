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
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const PORT = parseInt(process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1] : '7103', 10);
const BE_HOME = '/home/petar/AppServer/BEServer';
const TOMCAT_PORT = 8080;

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

function getAgents() {
    const nfjobsRaw = runCmd(`${BE_HOME}/sbin/nfjobs 2>/dev/null`);
    const nfcheckRaw = runCmd(`${BE_HOME}/sbin/nfcheckall 2>/dev/null`);

    const agents = [];
    for (const line of nfjobsRaw.split('\n')) {
        const m = line.match(/Name:\s+(\S+)\s+PID:\s+(\d+)\s+Start Time:\s+(.*)/);
        if (m) {
            agents.push({
                name: m[1], pid: +m[2], started: m[3].trim(), accessible: false,
            });
        }
    }

    for (const line of nfcheckRaw.split('\n')) {
        const m = line.match(/Agentsystem\s+(\S+)\s+exists and is accessible/);
        if (m) {
            const agent = agents.find(a => a.name === m[1]);
            if (agent) agent.accessible = true;
        }
    }

    for (const a of agents) {
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

        // Uptime — parse "Thu Mar 12 07:02:13 PM EET 2026" format
        if (a.started) {
            try {
                // Remove timezone abbreviation (EET, EEST, etc.) that Node can't parse
                const cleanDate = a.started.replace(/\s(?:EET|EEST|CET|CEST|UTC|GMT|MSK|IST|EST|CST|PST|EDT|CDT|PDT|WET|WEST)\b/g, '');
                const parsed = new Date(cleanDate);
                if (!isNaN(parsed.getTime())) {
                    a.uptime_seconds = Math.floor((Date.now() - parsed.getTime()) / 1000);
                }
            } catch { /* ignore */ }
        }

        // Threads & FDs
        const threadCount = runCmd(`cat /proc/${a.pid}/status 2>/dev/null | grep Threads | awk '{print $2}'`);
        const openFds = runCmd(`ls /proc/${a.pid}/fd 2>/dev/null | wc -l`);
        if (threadCount) a.threads = parseInt(threadCount, 10) || 0;
        if (openFds) a.open_fds = parseInt(openFds, 10) || 0;
    }

    const total = agents.length;
    const healthy = agents.filter(a => a.accessible).length;
    return { agents, total, healthy };
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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    next();
});

app.get('/status', async (_req, res) => {
    const data = await collectStatus();
    res.json(data);
});

app.get('/ping', (_req, res) => {
    res.type('text/plain').send('pong');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Status API listening on :${PORT}`);
});
