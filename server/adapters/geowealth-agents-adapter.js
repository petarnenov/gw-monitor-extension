const fs = require('fs');
const yaml = require('js-yaml');
const ProcessManagerAdapter = require('./process-adapter');
const { runCmd, runAsync } = require('../utils');

class GeoWealthAgentsAdapter extends ProcessManagerAdapter {
    constructor(config) {
        super(config);
        this.sbin = config.paths.sbin;
        this.pidsDir = config.paths.pids;
        this.logsDir = config.paths.logs;
        this.agentConfig = config.agents || {};
        this.envVars = this.agentConfig.env_vars
            ? Object.entries(this.agentConfig.env_vars).map(([k, v]) => `${k}="${v}"`).join(' ')
            : '';
    }

    getConfiguredProcesses() {
        const configFile = this.agentConfig.config_file;
        const envKey = this.agentConfig.env_key;
        const serverKey = this.agentConfig.server_key;
        if (!configFile) return [];
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

    getAll() {
        const nfjobsRaw = runCmd(`${this.sbin}/nfjobs 2>/dev/null`);
        const nfcheckRaw = runCmd(`${this.sbin}/nfcheckall 2>/dev/null`);
        const configured = this.getConfiguredProcesses();

        const runningMap = {};
        for (const line of nfjobsRaw.split('\n')) {
            const m = line.match(/Name:\s+(\S+)\s+PID:\s+(\d+)\s+Start Time:\s+(.*)/);
            if (m) runningMap[m[1]] = { pid: +m[2], started: m[3].trim() };
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
            if (running) this._enrichRunning(a);
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
                this._enrichRunning(a);
                agents.push(a);
            }
        }

        const total = configured.length;
        const running = agents.filter(a => a.running).length;
        const healthy = agents.filter(a => a.accessible).length;
        return { agents, total, running, healthy };
    }

    async startProcess(name) {
        await runAsync(`${this.envVars} ${this.sbin}/nfstart ${name} 2>&1`, 60000);
    }

    async stopProcess(name) {
        await runAsync(`${this.sbin}/nfstop ${name} 2>&1`, 60000);
    }

    async restartAll() {
        const restartCmd = this.agentConfig.commands && this.agentConfig.commands.restart_all
            ? this.agentConfig.commands.restart_all
            : `${this.sbin}/restart_agents.sh`;
        await runAsync(`${this.envVars} ${restartCmd} 2>&1`, 300000);
    }

    updateMemory(name, value) {
        const configFile = this.agentConfig.config_file;
        const raw = fs.readFileSync(configFile, 'utf8');
        const lines = raw.split('\n');
        let inAgent = false;
        for (let i = 0; i < lines.length; i++) {
            const nameMatch = lines[i].match(/^\s+-\s+name:\s+(\S+)/);
            if (nameMatch) inAgent = nameMatch[1] === name;
            if (inAgent && lines[i].match(/^\s+max_memory:\s+/)) {
                const indent = lines[i].match(/^(\s+)/)[1];
                lines[i] = `${indent}max_memory: ${value}`;
                fs.writeFileSync(configFile, lines.join('\n'), 'utf8');
                return true;
            }
        }
        return false;
    }

    updateAutostart(name, enabled) {
        const configFile = this.agentConfig.config_file;
        const raw = fs.readFileSync(configFile, 'utf8');
        const lines = raw.split('\n');
        let inAgent = false;
        let agentStartIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            const nameMatch = lines[i].match(/^\s+-\s+name:\s+(\S+)/);
            if (nameMatch) {
                inAgent = nameMatch[1] === name;
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

    getLogPath(name) {
        const logFileName = this.agentConfig.log_file || 'stdout.log';
        return `${this.logsDir}/${name}/${logFileName}`;
    }

    processExists(name) {
        return fs.existsSync(`${this.pidsDir}/${name}.pid`);
    }

    _enrichRunning(a) {
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
            const cmdline = fs.readFileSync(`/proc/${a.pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
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
}

module.exports = GeoWealthAgentsAdapter;
