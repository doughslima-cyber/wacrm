#!/usr/bin/env bash
# Database for `npm run dev` on this workstation: a separate stack on the
# VPS (compose project wacrm-dev: its own Postgres, PostgREST and relay;
# compose.dev.yml), reached through an SSH tunnel. Nothing to install
# locally.
#
#   bash infra/vps/dev.sh up       once, and after pulling new migrations:
#                                  starts the stack, applies the migrations
#                                  from THIS checkout, points .env.local at it
#   bash infra/vps/dev.sh tunnel   keep it open while `npm run dev` runs
#
# The dev secrets are generated on the VPS (infra/vps/.env.dev) and only
# POSTGREST_JWT_SECRET is copied here, straight into .env.local.
#
# The Firebase project is shared with the test deploy, so custom claims
# (accountIds, userId) follow whichever database the user last signed in
# to. Use different Firebase users for dev and for crm.dhscode.com.br.
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${HOST:-servidor}"
DIR="${DIR:-wacrm}"
PGRST_PORT="${DEV_POSTGREST_PORT:-3201}"
DB_PORT="${DEV_DB_PORT:-3202}"
# Keepalives every 15s: a dead connection is noticed within ~45s instead
# of hanging until TCP gives up.
TUNNEL=(-N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L "${PGRST_PORT}:127.0.0.1:${PGRST_PORT}" -L "${DB_PORT}:127.0.0.1:${DB_PORT}" "$HOST")

remote_env() { ssh "$HOST" "sed -n 's/^$1=//p' ~/$DIR/infra/vps/.env.dev"; }

# Sets KEY=value in .env.local, replacing an existing (or commented) line.
set_local() {
  local key="$1" value="$2" file=.env.local
  touch "$file"
  node -e '
    const fs = require("fs"); const [file, key, value] = process.argv.slice(1);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const i = lines.findIndex((l) => new RegExp(`^#?\\s*${key}=`).test(l));
    if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
    fs.writeFileSync(file, lines.join("\n"));
  ' "$file" "$key" "$value"
}

# Comments out KEY in .env.local (the Cloud Run-only settings).
unset_local() {
  node -e '
    const fs = require("fs"); const [file, key] = process.argv.slice(1);
    if (!fs.existsSync(file)) process.exit(0);
    const out = fs.readFileSync(file, "utf8").split(/\r?\n/)
      .map((l) => (l.startsWith(`${key}=`) ? `# ${l}` : l));
    fs.writeFileSync(file, out.join("\n"));
  ' .env.local "$1"
}

case "${1:-}" in
  up)
    ssh "$HOST" bash -s -- "$DIR" <<'REMOTE'
set -euo pipefail
cd ~/"$1"
git pull --quiet --ff-only || echo "note: ~/$1 not updated (relay code may be older than yours)" >&2
ENV_FILE=infra/vps/.env.dev
if [[ ! -f "$ENV_FILE" ]]; then
  hex() { openssl rand -hex 32; }
  umask 077
  cat >"$ENV_FILE" <<ENV
# Dev stack (infra/vps/dev.sh). Generated here; throwaway data.
POSTGRES_PASSWORD=$(hex)
AUTHENTICATOR_PASSWORD=$(hex)
RELAY_PASSWORD=$(hex)
POSTGREST_JWT_SECRET=$(hex)
GCP_CREDENTIALS_FILE=$HOME/.wacrm-secrets/gcp-key.json
NEXT_PUBLIC_FIREBASE_PROJECT_ID=$(sed -n 's/^NEXT_PUBLIC_FIREBASE_PROJECT_ID=//p' infra/vps/.env)
# Unused by the dev stack (no app or cron), but compose.yml requires them.
ENCRYPTION_KEY=unused
META_APP_SECRET=unused
AUTOMATION_CRON_SECRET=unused
NEXT_PUBLIC_FIREBASE_API_KEY=unused
NEXT_PUBLIC_FIREBASE_APP_ID=unused
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=unused
NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV
  echo "created ~/$1/$ENV_FILE"
fi
docker compose -p wacrm-dev --env-file "$ENV_FILE" -f infra/vps/compose.yml -f infra/vps/compose.dev.yml \
  up -d --wait db
docker compose -p wacrm-dev --env-file "$ENV_FILE" -f infra/vps/compose.yml -f infra/vps/compose.dev.yml \
  up -d --build db postgrest relay
REMOTE

    # Migrations from this checkout, through a short-lived tunnel.
    ssh "${TUNNEL[@]}" &
    tunnel_pid=$!
    trap 'kill $tunnel_pid 2>/dev/null || true' EXIT
    sleep 3
    (
      cd infra
      [[ -d node_modules ]] || npm ci --no-audit --no-fund --loglevel=error
      DATABASE_URL="postgres://postgres:$(remote_env POSTGRES_PASSWORD)@127.0.0.1:${DB_PORT}/postgres" \
        AUTHENTICATOR_PASSWORD="$(remote_env AUTHENTICATOR_PASSWORD)" \
        RELAY_PASSWORD="$(remote_env RELAY_PASSWORD)" \
        node db/migrate.mjs
    )

    set_local POSTGREST_URL "http://localhost:${PGRST_PORT}"
    set_local POSTGREST_JWT_SECRET "$(remote_env POSTGREST_JWT_SECRET)"
    unset_local POSTGREST_ID_TOKEN_COMMAND
    echo ".env.local now points at the dev stack. Next: bash infra/vps/dev.sh tunnel, then npm run dev"
    ;;
  tunnel)
    # Reconnects when the connection drops (a reset on the way to the
    # VPS kills ssh with 255); Ctrl+C ends it. The wait doubles up to 30s
    # while reconnecting fails, and starts over after a connection that
    # held for a minute.
    trap 'echo; echo "tunnel closed"; exit 0' INT TERM
    delay=2
    while true; do
      echo "tunnel open: PostgREST on localhost:${PGRST_PORT}, Postgres on localhost:${DB_PORT} (Ctrl+C to close)"
      started=$(date +%s)
      ssh "${TUNNEL[@]}" || true
      (( $(date +%s) - started >= 60 )) && delay=2
      echo "tunnel dropped at $(date +%H:%M:%S); reconnecting in ${delay}s" >&2
      sleep "$delay"
      delay=$(( delay * 2 > 30 ? 30 : delay * 2 ))
    done
    ;;
  *)
    echo "usage: bash infra/vps/dev.sh up | tunnel" >&2
    exit 1
    ;;
esac
