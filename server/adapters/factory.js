const TomcatAdapter = require('./tomcat-adapter');
const GradleAdapter = require('./gradle-adapter');
const GeoWealthAgentsAdapter = require('./geowealth-agents-adapter');

function createAppServerAdapter(config) {
    switch (config.app_server.type) {
        case 'tomcat': return new TomcatAdapter(config);
        default: throw new Error(`Unknown app server type: ${config.app_server.type}`);
    }
}

function createBuildAdapter(config, deployEnv) {
    switch (config.build.type) {
        case 'gradle': return new GradleAdapter(config, deployEnv);
        default: throw new Error(`Unknown build type: ${config.build.type}`);
    }
}

function createProcessAdapter(config) {
    const format = config.agents && config.agents.config_format;
    switch (format) {
        case 'geowealth_yaml': return new GeoWealthAgentsAdapter(config);
        default: return new GeoWealthAgentsAdapter(config); // default fallback
    }
}

function createAdapters(config, deployEnv) {
    return {
        appServer: createAppServerAdapter(config),
        build: createBuildAdapter(config, deployEnv),
        processManager: config.agents ? createProcessAdapter(config) : null,
    };
}

module.exports = { createAdapters };
