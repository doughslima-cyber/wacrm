#!/usr/bin/env bash
# Deploys relay-realtime (Cloud SQL app_realtime.changes → Firestore
# signals, docs/firebase-migration.md phase 4) to Cloud Run.
#
# - Exactly one instance, CPU always allocated: the process holds a
#   LISTEN connection and works between requests, which a throttled or
#   scaled-to-zero instance can't do. One is also enough — two would
#   only take turns on the queue (FOR UPDATE SKIP LOCKED).
# - Built by Cloud Build from this folder's Dockerfile.
# - Not public: the HTTP port only exists for Cloud Run's health check.
#
# One-time setup, idempotent (SETUP=1): the service account and its
# roles, the DB password secret and the Firestore TTL policy on
# signals. The realtime_relay password itself is set by
#   cd infra && RELAY_PASSWORD=... npm run db:migrate
# with the same value stored in the pg-relay-password secret.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="${PROJECT:-crm-zap-cbd5d}"
REGION="${REGION:-southamerica-east1}"
INSTANCE="${INSTANCE:-wacrm-pg}"
SERVICE="${SERVICE:-relay-realtime}"
SA="relay-realtime@${PROJECT}.iam.gserviceaccount.com"

if [[ "${SETUP:-0}" == "1" ]]; then
  gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
    gcloud iam service-accounts create relay-realtime --project "$PROJECT" \
      --display-name "relay-realtime (Cloud SQL → Firestore signals)"
  # A service account created a moment ago can take a minute to be
  # visible to IAM ("does not exist"), so the bindings retry.
  bind() {
    for attempt in 1 2 3 4 5 6; do
      "$@" >/dev/null && return 0
      echo "IAM hasn't seen ${SA} yet, retrying in 10s ($attempt/6)" >&2
      sleep 10
    done
    return 1
  }
  for role in roles/cloudsql.client roles/datastore.user; do
    bind gcloud projects add-iam-policy-binding "$PROJECT" \
      --member "serviceAccount:${SA}" --role "$role" --condition None
  done
  gcloud secrets describe pg-relay-password --project "$PROJECT" >/dev/null 2>&1 ||
    echo "create the pg-relay-password secret first (gcloud secrets create ... --data-file)" >&2
  bind gcloud secrets add-iam-policy-binding pg-relay-password --project "$PROJECT" \
    --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor
  # Signals are only useful for a moment; Firestore deletes them once
  # expireAt passes (usually within a day of it).
  gcloud firestore fields ttls update expireAt --project "$PROJECT" \
    --collection-group changes --enable-ttl --async
fi

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --source . \
  --service-account "$SA" \
  --no-allow-unauthenticated \
  --no-cpu-throttling \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 1 \
  --max-instances 1 \
  --concurrency 10 \
  --set-secrets "DB_PASSWORD=pg-relay-password:latest" \
  --set-env-vars "INSTANCE_CONNECTION_NAME=${PROJECT}:${REGION}:${INSTANCE},FIRESTORE_PROJECT=${PROJECT}"
