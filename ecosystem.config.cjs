// pm2 설정: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "word-rush",
      cwd: __dirname,
      script: "/opt/homebrew/bin/uv",
      args: "run uvicorn app.main:app --host 127.0.0.1 --port 5020 --proxy-headers --forwarded-allow-ips='*'",
      interpreter: "none",
      autorestart: true,
      max_restarts: 10,
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
