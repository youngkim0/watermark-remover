#!/usr/bin/env bash
# Deploy Unmark to Hermes (https://unmark.live).
#
#   ./deploy/deploy.sh          # deploys the committed HEAD
#
# git archive (committed files only) → /opt/unmark/src → docker build on the
# box → start a candidate, swap only once it answers; the previous image stays
# as unmark:previous for rollback. No runtime env; build-time NEXT_PUBLIC_*
# live in /opt/unmark/.env.build. No published port: Caddy reaches
# unmark:3000 on supabase_default. Avoid weekdays ~22:45 UTC (invest job).
set -euo pipefail
HOST=root@158.247.201.234
REF=${1:-HEAD}
cd "$(dirname "$0")/.."

echo "▸ shipping $(git rev-parse --short "$REF")"
git archive --format=tar "$REF" | ssh "$HOST" 'rm -rf /opt/unmark/src && mkdir -p /opt/unmark/src && tar -x -C /opt/unmark/src'

ssh "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/unmark
cp .env.build src/.env.build
echo "▸ building"
docker build -q -t unmark:new src >/dev/null
rm -f src/.env.build

run() { docker run -d --name "$1" --network supabase_default --restart unless-stopped \
  --memory=300m --memory-swap=600m "$2" >/dev/null; }
probe() { docker run --rm --network supabase_default curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}' --max-time 8 "http://$1:3000$2"; }
healthy() { for i in $(seq 1 30); do
  [ "$(probe "$1" /)" = 200 ] && [ "$(probe "$1" /models/NOTICE-isnet.txt)" = 200 ] && return 0
  sleep 2; done; return 1; }

docker rm -f unmark-next >/dev/null 2>&1 || true
run unmark-next unmark:new
if ! healthy unmark-next; then
  echo "✗ new build did not answer — keeping the running one"; docker logs --tail 40 unmark-next; docker rm -f unmark-next >/dev/null; exit 1
fi
docker rm -f unmark-next >/dev/null

docker tag unmark:latest unmark:previous 2>/dev/null || true
docker tag unmark:new unmark:latest
docker rm -f unmark >/dev/null 2>&1 || true
run unmark unmark:latest
healthy unmark || { echo "✗ unhealthy after swap — rolling back"; docker rm -f unmark; run unmark unmark:previous; exit 1; }
docker image prune -f >/dev/null
echo "✓ live: $(docker inspect unmark --format '{{.Image}}' | cut -c8-19)"
REMOTE
