module.exports = {
  apps: [{
    name: 'gw-monitor',
    script: 'server/index.js',
    args: '--config ./config.yml',
    watch: false,
    restart_delay: 3000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
    },
  }],
};
