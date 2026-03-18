/**
 * Configuration loader — reads a YAML config file, resolves template
 * variables, and validates required fields.
 *
 * Usage:
 *   const { loadConfig } = require('./config');
 *   const config = loadConfig('./config.yml');
 */

const yaml = require('js-yaml');
const fs = require('fs');
const path = require('path');

/**
 * Resolve template variables like {paths.deploy_target} within string values.
 * Walks the entire config tree and replaces {a.b.c} with the resolved value.
 */
function resolveTemplates(obj, root) {
    for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string') {
            obj[key] = obj[key].replace(/\{([^}]+)\}/g, (match, path) => {
                const val = getNestedValue(root, path);
                return val !== undefined ? val : match;
            });
        } else if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
            resolveTemplates(obj[key], root);
        } else if (Array.isArray(obj[key])) {
            obj[key] = obj[key].map(item => {
                if (typeof item === 'string') {
                    return item.replace(/\{([^}]+)\}/g, (match, p) => {
                        const val = getNestedValue(root, p);
                        return val !== undefined ? val : match;
                    });
                }
                if (item && typeof item === 'object') {
                    resolveTemplates(item, root);
                }
                return item;
            });
        }
    }
}

/**
 * Get a nested value from an object using dot notation.
 * e.g. getNestedValue(config, 'app_server.home') => '/path/to/tomcat'
 */
function getNestedValue(obj, path) {
    return path.split('.').reduce((curr, key) => {
        return curr && curr[key] !== undefined ? curr[key] : undefined;
    }, obj);
}

/**
 * Load and validate a configuration file.
 *
 * @param {string} configPath - Path to YAML config file
 * @returns {object} Parsed and validated config
 */
function loadConfig(configPath) {
    const resolved = path.resolve(configPath);

    if (!fs.existsSync(resolved)) {
        throw new Error(`Config file not found: ${resolved}`);
    }

    const raw = fs.readFileSync(resolved, 'utf8');
    const config = yaml.load(raw);

    if (!config || typeof config !== 'object') {
        throw new Error(`Invalid config file: ${resolved}`);
    }

    // Resolve template variables (two passes to handle nested references)
    resolveTemplates(config, config);
    resolveTemplates(config, config);

    // Validate required fields
    const required = [
        'server.port',
        'paths.source',
        'paths.deploy_target',
        'app_server.type',
        'app_server.home',
        'app_server.port',
        'build.type',
    ];

    const missing = required.filter(key => getNestedValue(config, key) === undefined);
    if (missing.length > 0) {
        throw new Error(`Missing required config fields:\n  ${missing.join('\n  ')}`);
    }

    // Derive convenience paths if not set
    if (!config.app_server.bin_dir) {
        config.app_server.bin_dir = config.app_server.home + '/bin';
    }
    if (!config.app_server.logs_dir) {
        config.app_server.logs_dir = config.app_server.home + '/logs';
    }
    if (!config.paths.sbin) {
        config.paths.sbin = config.paths.deploy_target + '/sbin';
    }
    if (!config.paths.pids) {
        config.paths.pids = config.paths.deploy_target + '/pids';
    }
    if (!config.paths.logs) {
        config.paths.logs = config.paths.deploy_target + '/logs';
    }

    // Defaults
    if (!config.server.name) {
        config.server.name = 'Server Monitor';
    }
    if (!config.app_server.health_check) {
        config.app_server.health_check = {};
    }
    if (config.app_server.health_check.timeout_ms === undefined) {
        config.app_server.health_check.timeout_ms = 5000;
    }
    if (!config.thresholds) {
        config.thresholds = {};
    }
    if (config.thresholds.ram_critical === undefined) {
        config.thresholds.ram_critical = 95;
    }
    if (!config.exec_whitelist) {
        config.exec_whitelist = [];
    }

    return config;
}

module.exports = { loadConfig, getNestedValue };
