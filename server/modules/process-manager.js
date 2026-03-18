const fs = require('fs');
const yaml = require('js-yaml');
const { runCmd, runAsync } = require('../utils');

function getConfiguredAgents(config) {
    if (!config.agents) return [];
    const configFile = config.agents.config_file;
    const envKey = config.agents.env_key;
    const serverKey = config.agents.server_key;
    try {
        const raw = fs.readFileSync(configFile, 'utf8');
        const doc = yaml.load(raw);
        const env = doc.environments[envKey];
        if (!env) return [];
        const server = env.servers[serverKey];
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

function updateAgentMemory(config, agentName, newMemory) {
    const configFile = config.agents.config_file;
    const raw = fs.readFileSync(configFile, 'utf8');
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
            fs.writeFileSync(configFile, lines.join('\n'), 'utf8');
            return true;
        }
    }
    return false;
}

function updateAgentAutostart(config, agentName, enabled) {
    const configFile = config.agents.config_file;
    const raw = fs.readFileSync(configFile, 'utf8');
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
                lines.splice(i, 1);
            } else {
                const indent = lines[i].match(/^(\s+)/)[1];
                lines[i] = `${indent}autostart: no_autostart`;
            }
            fs.writeFileSync(configFile, lines.join('\n'), 'utf8');
            return true;
        }
        if (!inAgent && agentStartIdx >= 0 && nameMatch) {
            if (!enabled) {
                const prevIndent = lines[agentStartIdx].match(/^(\s+-\s+)/)[0].replace('-', ' ');
                lines.splice(i, 0, `${prevIndent}autostart: no_autostart`);
                fs.writeFileSync(configFile, lines.join('\n'), 'utf8');
                return true;
            }
            return true;
        }
    }
    if (inAgent && !enabled) {
        const indent = lines[agentStartIdx].match(/^(\s+-\s+)/)[0].replace('-', ' ');
        lines.push(`${indent}autostart: no_autostart`);
        fs.writeFileSync(configFile, lines.join('\n'), 'utf8');
        return true;
    }
    if (inAgent && enabled) return true;
    return false;
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

function getProcesses(config) {
    const SBIN = config.paths.sbin;
    const nfjobsRaw = runCmd(`${SBIN}/nfjobs 2>/dev/null`);
    const nfcheckRaw = runCmd(`${SBIN}/nfcheckall 2>/dev/null`);

    const configured = getConfiguredAgents(config);

    const runningMap = {};
    for (const line of nfjobsRaw.split('\n')) {
        const m = line.match(/Name:\s+(\S+)\s+PID:\s+(\d+)\s+Start Time:\s+(.*)/);
        if (m) {
            runningMap[m[1]] = { pid: +m[2], started: m[3].trim() };
        }
    }

    const accessibleSet = new Set();
    for (const line of nfcheckRaw.split('\n')) {
        const m = line.match(/Agentsystem\s+(\S+)\s+exists and is accessible/);
        if (m) accessibleSet.add(m[1]);
    }

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
        if (running) enrichRunningAgent(a);
        agents.push(a);
    }

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

function registerRoutes(app, config) {
    const SBIN = config.paths.sbin;
    const agentEnvVars = config.agents && config.agents.env_vars
        ? Object.entries(config.agents.env_vars).map(([k, v]) => `${k}="${v}"`).join(' ')
        : '';

    app.post('/stop/agent/:name', async (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).json({ ok: false, message: 'Invalid agent name' });
        }
        const pidFile = `${config.paths.pids}/${name}.pid`;
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

    app.post('/restart/agent/:name', async (req, res) => {
        const name = req.params.name;
        if (!/^[a-z][a-z0-9]*$/.test(name)) {
            return res.status(400).json({ ok: false, message: 'Invalid agent name' });
        }
        const pidFile = `${config.paths.pids}/${name}.pid`;
        if (!fs.existsSync(pidFile)) {
            return res.status(404).json({ ok: false, message: `Agent "${name}" not found` });
        }
        try {
            console.log(`[restart] Stopping agent ${name}...`);
            await runAsync(`${SBIN}/nfstop ${name} 2>&1`, 60000);
            console.log(`[restart] Starting agent ${name}...`);
            await runAsync(`${agentEnvVars} ${SBIN}/nfstart ${name} 2>&1`, 60000);
            console.log(`[restart] Agent ${name} start command completed, accessibility will be checked by client`);
            res.json({ ok: true, message: `Agent "${name}" restarted` });
        } catch (e) {
            console.error(`[restart] Agent ${name} restart failed:`, e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/restart/agents', async (_req, res) => {
        try {
            console.log('[restart] Restarting all agents...');
            const restartCmd = config.agents && config.agents.commands && config.agents.commands.restart_all
                ? config.agents.commands.restart_all
                : `${SBIN}/restart_agents.sh`;
            await runAsync(`${agentEnvVars} ${restartCmd} 2>&1`, 300000);
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
            const updated = updateAgentAutostart(config, name, enabled);
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
            const updated = updateAgentMemory(config, name, memory);
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
}

module.exports = { getProcesses, registerRoutes };
