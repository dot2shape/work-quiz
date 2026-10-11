// pm2 설정: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "word-rush",
      cwd: __dirname,
      script: "scripts/start.sh",
      interpreter: "bash",
      autorestart: true,
      max_restarts: 10,
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
