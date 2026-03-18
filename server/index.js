#!/usr/bin/env node
/**
 * Server Status API — Express server that exposes system and agent
 * status as JSON for the Server Monitor Chrome extension.
 *
 * Usage:
 *   node server/index.js --config ./config.yml
 *   node server/index.js --config ./config.yml --port 9876
 */

const express = require('express');
const { loadConfig } = require('../config');

// ── Load configuration ──

const configArg = process.argv.find(a => a.startsWith('--config='))
    ?.split('=')[1]
    || (process.argv.includes('--config')
        ? process.argv[process.argv.indexOf('--config') + 1]
        : './config.yml');

const config = loadConfig(configArg);

const PORT = parseInt(process.argv.includes('--port')
    ? process.argv[process.argv.indexOf('--port') + 1] : config.server.port, 10);

// ── Load modules ──

const systemMonitor = require('./modules/system-monitor');
const appServer = require('./modules/app-server-manager');
const processManager = require('./modules/process-manager');
const gitOps = require('./modules/git-ops');
const deployPipeline = require('./modules/deploy-pipeline');
const logStreamer = require('./modules/log-streamer');
const commandExec = require('./modules/command-exec');

// ── Setup git auth and build deploy environment ──

const gitAuthResult = gitOps.setupGitAuth(config);
const deployEnv = gitOps.buildDeployEnv(config, gitAuthResult);

// ── Express app ──

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

// ── Aggregated status endpoint ──

app.get('/status', async (_req, res) => {
    const [system, tomcat, agentsData] = await Promise.all([
        systemMonitor.getSystemInfo(),
        appServer.getAppServerStatus(config),
        processManager.getProcesses(config),
    ]);
    res.json({ timestamp: Date.now() / 1000, system, tomcat, agents: agentsData });
});

app.get('/ping', (_req, res) => {
    res.type('text/plain').send('pong');
});

// ── Client config endpoint ──

app.get('/config/client', (_req, res) => {
    res.json({
        name: config.server.name,
        app_server_type: config.app_server.type,
        build_type: config.build.type,
        has_agents: !!config.agents,
        has_deploy: !!config.deploy,
        thresholds: config.thresholds || {},
    });
});

// ── Register module routes ──

systemMonitor.registerRoutes(app, config);
appServer.registerRoutes(app, config);
processManager.registerRoutes(app, config);
gitOps.registerRoutes(app, config);
deployPipeline.registerRoutes(app, config, deployEnv);
logStreamer.registerRoutes(app, config);
commandExec.registerRoutes(app, config, deployEnv);

// ── Start server ──

app.listen(PORT, '0.0.0.0', () => {
    console.log(`${config.server.name} API listening on :${PORT}`);
});
