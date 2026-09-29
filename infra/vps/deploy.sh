#!/usr/bin/env bash
# Deploys WACRM to the VPS over SSH (docs/firebase-migration.md, phase 5).
# Run from a workstation that has `ssh $HOST` and the Firebase CLI:
#
#   bash infra/vps/deploy.sh
#
# On the host it:
#   1. clones the repo into $DIR, or moves it to origin/$BRANCH (the
#      branch must be pushed; local changes on the host are discarded)
#   2. first run only: writes infra/vps/.env (chmod 600) with secrets
#      generated on the host itself, so they never pass through here,
#      plus the public Firebase web config read from `firebase
#      apps:sdkconfig`
#   3. builds the images, applies the migrations (only what's new),
#      restarts what changed and checks the app answers
#
# Env: HOST (default servidor), DIR (default ~/wacrm), BRANCH (default
# the current one), SITE_URL (default https://crm.dhscode.com.br).
set -euo pipefail
cd "$(dirname "$0")/../.."

HOST="${HOST:-servidor}"
DIR="${DIR:-wacrm}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REPO_URL="${REPO_URL:-$(git remote get-url origin)}"
PROJECT="${PROJECT:-crm-zap-cbd5d}"
SITE_URL="${SITE_URL:-https://crm.dhscode.com.br}"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]] ||
  [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/${BRANCH}" 2>/dev/null)" ]]; then
  echo "note: the host deploys origin/${BRANCH}; local changes that aren't pushed won't be there" >&2
fi

sdkconfig="$(firebase apps:sdkconfig WEB --project "$PROJECT" --json)"
read_config() { node -e "const c=JSON.parse(process.argv[1]).result;process.stdout.write((c.sdkConfig??c)[process.argv[2]])" "$sdkconfig" "$1"; }
API_KEY="$(read_config apiKey)"
APP_ID="$(read_config appId)"
BUCKET="$(read_config storageBucket)"

ssh "$HOST" bash -s -- "$DIR" "$BRANCH" "$REPO_URL" "$PROJECT" "$SITE_URL" "$API_KEY" "$APP_ID" "$BUCKET" <<'REMOTE'
set -euo pipefail
DIR="$1" BRANCH="$2" REPO_URL="$3" PROJECT="$4" SITE_URL="$5" API_KEY="$6" APP_ID="$7" BUCKET="$8"
cd ~

if [[ ! -d "$DIR/.git" ]]; then
  git clone --quiet "$REPO_URL" "$DIR"
fi
cd "$DIR"
git fetch --quiet origin "$BRANCH"
git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
echo "at $(git log -1 --format='%h %s')"

ENV_FILE=infra/vps/.env
if [[ ! -f "$ENV_FILE" ]]; then
  hex() { openssl rand -hex 32; }
  umask 077
  cat >"$ENV_FILE" <<ENV
# Written by infra/vps/deploy.sh on first deploy. Secrets were generated
# here and exist nowhere else: back this file up with the database.
POSTGRES_PASSWORD=$(hex)
AUTHENTICATOR_PASSWORD=$(hex)
RELAY_PASSWORD=$(hex)
POSTGREST_JWT_SECRET=$(hex)
ENCRYPTION_KEY=$(hex)
AUTOMATION_CRON_SECRET=$(hex)
# Placeholder: every webhook is refused until this is the Meta App Secret.
META_APP_SECRET=placeholder-$(hex)

# Service account key for Firebase Auth / Storage / Firestore. Keep it
# in a 0700 directory; the file itself must be readable by the
# containers' users (0644).
GCP_CREDENTIALS_FILE=$HOME/.wacrm-secrets/gcp-key.json

APP_PORT=3100
NEXT_PUBLIC_SITE_URL=$SITE_URL
NEXT_PUBLIC_APP_LOCALE=pt
NEXT_PUBLIC_FIREBASE_PROJECT_ID=$PROJECT
NEXT_PUBLIC_FIREBASE_API_KEY=$API_KEY
NEXT_PUBLIC_FIREBASE_APP_ID=$APP_ID
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=$BUCKET
ENV
  echo "created $DIR/$ENV_FILE"
fi

compose() { docker compose -f infra/vps/compose.yml "$@"; }
compose build --quiet app relay
compose up -d --wait db
# -T and </dev/null: this script arrives on ssh's stdin, and `run`
# would otherwise read the rest of it as the container's input.
compose --profile migrate run --rm -T migrate </dev/null
compose up -d db postgrest

# The app and the relay mount the key; a missing file would be mounted
# as an empty directory, so they wait for it.
KEY_FILE="$(sed -n 's/^GCP_CREDENTIALS_FILE=//p' "$ENV_FILE")"
if [[ ! -f "$KEY_FILE" ]]; then
  echo "database and PostgREST are up; app, relay and cron wait for the service account key at $KEY_FILE (docs/firebase-migration.md, phase 5)" >&2
  exit 2
fi
compose up -d --remove-orphans db postgrest relay app cron

for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(sed -n 's/^APP_PORT=//p' "$ENV_FILE")/login" || true)"
  [[ "$code" == "200" ]] && { echo "app is up (GET /login 200)"; exit 0; }
  sleep 2
done
echo "app did not answer on /login (last status: $code)" >&2
compose logs --tail 50 app >&2
exit 1
REMOTE
