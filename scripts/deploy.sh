#!/usr/bin/env bash
# Deploys this checkout to one host (see deploy/README.md).
#
#   scripts/deploy.sh USER@HOST PUBLIC_ORIGIN
#
# PUBLIC_ORIGIN is the address people open, e.g. http://203.0.113.7 or https://gurow.example.
# It is written to the host's deploy/.env only on the first deploy; later deploys keep that
# file. SSH options (such as -i KEY) are taken from DEPLOY_SSH_OPTS.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET=${1:?usage: scripts/deploy.sh USER@HOST PUBLIC_ORIGIN}
ORIGIN=${2:?usage: scripts/deploy.sh USER@HOST PUBLIC_ORIGIN}
SSH="ssh ${DEPLOY_SSH_OPTS:-}"
DIR=/opt/gurow

echo "== build the frontend"
(cd frontend && bun install --frozen-lockfile >/dev/null && bun run build >/dev/null)

echo "== prepare the host"
$SSH "$TARGET" 'bash -s' < deploy/provision.sh

echo "== copy the release"
rsync -az --delete -e "$SSH" --exclude node_modules --exclude .env --exclude test backend "$TARGET:$DIR/"
rsync -az --delete -e "$SSH" --relative frontend/.output "$TARGET:$DIR/"
rsync -az --delete -e "$SSH" --exclude .env deploy "$TARGET:$DIR/"

echo "== start"
# A domain origin makes Caddy serve it over HTTPS; a bare address is served over plain HTTP.
case "$ORIGIN" in
  https://*) SITE=${ORIGIN#https://} ;;
  *) SITE=:80 ;;
esac
$SSH "$TARGET" "cd $DIR/deploy && if [ ! -f .env ]; then umask 077 && printf 'PUBLIC_ORIGIN=%s\nSITE_ADDRESS=%s\nPOSTGRES_PASSWORD=%s\nBETTER_AUTH_SECRET=%s\nEMAIL_VERIFICATION=required\n' '$ORIGIN' '$SITE' \"\$(openssl rand -hex 24)\" \"\$(openssl rand -hex 32)\" > .env && echo 'created deploy/.env'; fi && sudo docker compose up -d --build --remove-orphans && sudo docker compose ps"
