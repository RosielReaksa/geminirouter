module.exports = {
  apps: [
    {
      name: 'geminirouter-core',
      script: 'dist/core/main.cjs',
      cwd: '/opt/geminirouter',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8045
      }
    },
    {
      name: 'geminirouter-web',
      script: 'dist/web/server.cjs',
      cwd: '/opt/geminirouter',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        CORE_PORT: 8045
      }
    }
  ]
};
