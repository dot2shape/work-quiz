#!/bin/bash
# pm2가 실행하는 기동 스크립트. 프로젝트 루트로 이동한 뒤 uvicorn을 띄운다.
cd "$(dirname "$0")/.." || exit 1
exec /opt/homebrew/bin/uv run uvicorn app.main:app --host 127.0.0.1 --port "${PORT:-5020}" --proxy-headers --forwarded-allow-ips='*'
