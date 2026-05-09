module.exports = {
  apps: [
    {
      name: "kytsunia",
      script: "./dist/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      node_args: "--env-file=.env",
      env: {
        NODE_ENV: "production",
      },
      time: true,
      merge_logs: true,
    },
  ],
};
