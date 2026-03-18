const { spawn } = require('child_process');
const { runCmd, runCmdStrict } = require('../utils');

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

function registerRoutes(app, config) {
    app.post('/system/clear-swap', async (_req, res) => {
        try {
            runCmdStrict('sudo swapoff -a && sudo swapon -a', 120000);
            const memAfter = runCmd('free -b --si');
            let swapInfo = '';
            for (const line of memAfter.split('\n')) {
                if (line.startsWith('Swap:')) {
                    const p = line.split(/\s+/);
                    swapInfo = `Swap used: ${(+p[2] / 1e9).toFixed(1)} GB / ${(+p[1] / 1e9).toFixed(1)} GB`;
                }
            }
            console.log('[system] Clear swap:', swapInfo);
            res.json({ ok: true, message: `Swap cleared. ${swapInfo}` });
        } catch (e) {
            console.error('[system] Clear swap error:', e.message);
            res.status(500).json({ ok: false, message: e.message });
        }
    });

    app.post('/system/free-ram', async (_req, res) => {
        const results = [];
        try {
            runCmd('sync');
            runCmd('echo 3 | sudo tee /proc/sys/vm/drop_caches 2>&1');
            results.push('Filesystem caches dropped');

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

    app.post('/restart/server', (_req, res) => {
        console.log('[restart] Status server restart requested');
        res.json({ ok: true, message: 'Server restarting via pm2' });
        setTimeout(() => {
            spawn('pm2', ['restart', 'gw-monitor'], {
                detached: true,
                stdio: 'ignore',
            }).unref();
        }, 500);
    });
}

module.exports = { getSystemInfo, registerRoutes };
