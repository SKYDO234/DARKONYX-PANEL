module.exports = {
  apps: [
    {
      name: 'darkonyx',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT_WEB: 3001,
        PORT_API: 3003,
        PORT_SFTP: 3004,
        DB_DRIVER: 'sqlite',
        DB_FILE: './data/darkonyx.sqlite3'
      }
    }
  ]
};
