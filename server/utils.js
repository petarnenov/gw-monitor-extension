const { execSync, exec } = require('child_process');

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

function runAsync(cmd, timeout = 120000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, env: { ...process.env } }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
        });
    });
}

function lastLines(str, n) {
    if (!str) return '';
    const lines = str.split('\n');
    return lines.slice(-n).join('\n');
}

module.exports = { runCmd, runCmdStrict, runAsync, lastLines };
