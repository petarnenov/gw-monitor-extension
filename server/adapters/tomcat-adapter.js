const fs = require('fs');
const http = require('http');
const AppServerAdapter = require('./app-server-adapter');
const { runCmd, runAsync } = require('../utils');

class TomcatAdapter extends AppServerAdapter {
    constructor(config) {
        super(config);
        this.home = config.app_server.home;
        this.port = config.app_server.port;
        this.binDir = config.app_server.bin_dir;
        this.hc = config.app_server.health_check || {};
    }

    async start() {
        await runAsync(`${this.binDir}/startup.sh 2>&1`);
    }

    async stop(gracePeriodMs = 30000) {
        await runAsync(`${this.binDir}/shutdown.sh 2>&1`, 30000).catch(() => {});
        await this.waitForStop(gracePeriodMs);
    }

    getProcessInfo() {
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

    async getStatus() {
        return new Promise((resolve) => {
            const start = Date.now();
            const req = http.get(`http://localhost:${this.port}/`, { timeout: 5000 }, async (res) => {
                res.resume();
                const elapsed = Date.now() - start;
                const proc = this.getProcessInfo();
                const ready = res.statusCode === 200 ? await this.isReady() : false;
                resolve({
                    http_port: this.port, http_code: res.statusCode,
                    response_ms: elapsed, running: res.statusCode === 200,
                    ready,
                    cluster: this.getClusterStatus(),
                    process: proc,
                    threads: this._getThreads(proc.pid),
                    jvm: this.getRuntimeConfig(proc.pid),
                    webapps: this.getDeployedApps(),
                    requests_today: this.getRequestsToday(),
                });
            });
            req.on('error', () => {
                const proc = this.getProcessInfo();
                resolve({
                    http_port: this.port, http_code: 0,
                    response_ms: Date.now() - start, running: false,
                    ready: false,
                    cluster: this.getClusterStatus(),
                    process: proc,
                    threads: this._getThreads(proc.pid),
                    jvm: this.getRuntimeConfig(proc.pid),
                    webapps: this.getDeployedApps(),
                    requests_today: this.getRequestsToday(),
                });
            });
            req.on('timeout', () => { req.destroy(); });
        });
    }

    async isReady() {
        const checkPath = this.hc.path || '/platformOne/checkPlatformStatus.do';
        const expectedStatus = this.hc.expected_status || 302;
        const timeout = this.hc.timeout_ms || 5000;

        return new Promise((resolve) => {
            const req = http.get(`http://localhost:${this.port}${checkPath}`, { timeout }, (res) => {
                res.resume();
                resolve(res.statusCode === expectedStatus);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        });
    }

    getClusterStatus() {
        const logPath = this.getLogPath();
        // Read last 300 lines of catalina.out to find Akka cluster status
        const tail = runCmd(`tail -300 "${logPath}" 2>/dev/null`);
        if (!tail) return { healthy: null, missingServices: [], message: 'Cannot read logs' };

        const lines = tail.split('\n');
        let healthy = null;
        let missingServices = [];
        let message = '';
        let lastEventTime = '';
        const recentEvents = [];

        // Scan bottom-up to find the most recent cluster status
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];

            // "Still missing [xxx, yyy]"
            if (healthy === null && line.includes('Still missing [')) {
                const match = line.match(/Still missing \[([^\]]+)\]/);
                if (match) {
                    healthy = false;
                    missingServices = match[1].split(',').map(s => s.trim());
                    message = `Missing: ${missingServices.join(', ')}`;
                    const timeMatch = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                    if (timeMatch) lastEventTime = timeMatch[1];
                }
            }

            // "All providers are connected" or "We know all servers are there"
            if (healthy === null && (line.includes('All providers are connected') || line.includes('We know all servers are there'))) {
                healthy = true;
                message = 'All providers connected';
                const timeMatch = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                if (timeMatch) lastEventTime = timeMatch[1];
            }

            // Collect recent cluster events (downed, removed, quarantined)
            if (recentEvents.length < 10) {
                if (line.includes('Member is Downed:') || line.includes('Member is Removed:') ||
                    line.includes('quarantined this node') || line.includes('Shutting down myself') ||
                    line.includes('SBR took decision')) {
                    const timeMatch = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
                    const time = timeMatch ? timeMatch[1] : '';
                    // Extract a short description
                    let desc = '';
                    if (line.includes('Member is Downed:')) {
                        const m = line.match(/Member is Downed: \{([^}]+)\}/);
                        desc = `Downed: ${m ? m[1] : '?'}`;
                    } else if (line.includes('Member is Removed:')) {
                        const m = line.match(/Member is Removed: \{([^}]+)\}.*ROLES_LOST \{([^}]*)\}/);
                        desc = m ? `Removed: ${m[1]} (roles: ${m[2]})` : 'Member removed';
                    } else if (line.includes('quarantined this node')) {
                        desc = 'Node was quarantined';
                    } else if (line.includes('Shutting down myself')) {
                        desc = 'Cluster node shutting down';
                    } else if (line.includes('SBR took decision')) {
                        const m = line.match(/SBR took decision (\w+)/);
                        desc = `SBR decision: ${m ? m[1] : '?'}`;
                    }
                    if (desc) recentEvents.push({ time, description: desc });
                }
            }
        }

        if (healthy === null) healthy = true; // No status messages found - assume OK

        return {
            healthy,
            missingServices,
            message,
            lastEventTime,
            recentEvents,
        };
    }

    getLogPath() {
        const mainLog = this.config.app_server.logs && this.config.app_server.logs.main
            ? this.config.app_server.logs.main
            : 'logs/catalina.out';
        return `${this.home}/${mainLog}`;
    }

    getDeployedApps() {
        const webappsDir = `${this.home}/${this.config.app_server.webapps_dir || 'webapps'}`;
        try {
            const dirs = fs.readdirSync(webappsDir);
            return dirs.filter(d => {
                try {
                    return fs.statSync(`${webappsDir}/${d}`).isDirectory();
                } catch { return false; }
            });
        } catch {
            return [];
        }
    }

    getRequestsToday() {
        const today = new Date().toISOString().slice(0, 10);
        const accessLogPattern = this.config.app_server.logs && this.config.app_server.logs.access
            ? this.config.app_server.logs.access.replace('{date}', today)
            : `logs/localhost_access_log.${today}.txt`;
        const logFile = `${this.home}/${accessLogPattern}`;
        const count = runCmd(`wc -l < "${logFile}" 2>/dev/null`);
        return parseInt(count, 10) || 0;
    }

    getRuntimeConfig(pid) {
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

    async waitForStop(timeoutMs = 30000) {
        const pids = runCmd("pgrep -f catalina.startup.Bootstrap");
        if (!pids) return;
        const maxAttempts = Math.ceil(timeoutMs / 1000);
        for (let i = 0; i < maxAttempts; i++) {
            const alive = runCmd("pgrep -f catalina.startup.Bootstrap");
            if (!alive) return;
            await new Promise(r => setTimeout(r, 1000));
        }
        const remaining = runCmd("pgrep -f catalina.startup.Bootstrap");
        if (remaining) {
            for (const pid of remaining.split('\n').filter(Boolean)) {
                runCmd(`kill -9 ${pid} 2>/dev/null`);
            }
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    _getThreads(pid) {
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
}

module.exports = TomcatAdapter;
