const path = require('node:path');

const INSTALL_DIR = process.env.GEMINIROUTER_HOME || '/opt/geminirouter';
const CORE_HOME = process.env.CORE_HOME || path.join(INSTALL_DIR, 'core');
const CORE_MAIN_PATH = process.env.CORE_MAIN_PATH || path.join(CORE_HOME, 'dist', 'core', 'main.cjs');

module.exports = {
  apps: [
    {
      name: 'geminirouter-core',
      script: CORE_MAIN_PATH,
      cwd: CORE_HOME,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8045,
        HOME: '/home/geminirouter'
      }
    },
    {
      name: 'geminirouter-web',
      script: path.join(INSTALL_DIR, 'server', 'dist', 'index.js'),
      cwd: path.join(INSTALL_DIR, 'server'),
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        CORE_PORT: 8045,
        CORE_MAIN_PATH,
        HOME: '/home/geminirouter'
      }
    }
  ]
};
