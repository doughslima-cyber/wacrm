#!/usr/bin/env bash
# Deploys PostgREST to Cloud Run in front of the wacrm Cloud SQL instance.
#
# - Same PostgREST version the Supabase CLI pins (apps/cli-go/pkg/config/
#   templates/Dockerfile), so supabase-js query-builder calls behave the
#   same as on Supabase.
# - Connects over the Cloud SQL unix socket as `authenticator`; the full
#   DB URI and the JWT secret come from Secret Manager.
# - Not public: callers need roles/run.invoker and send their Google ID
#   token in X-Serverless-Authorization, which leaves Authorization free
#   for the app JWT PostgREST verifies.
set -euo pipefail

PROJECT="${PROJECT:-crm-zap-cbd5d}"
REGION="${REGION:-southamerica-east1}"
INSTANCE="${INSTANCE:-wacrm-pg}"
SERVICE="${SERVICE:-postgrest}"
IMAGE="${IMAGE:-docker.io/postgrest/postgrest:v16.3}"

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "postgrest@${PROJECT}.iam.gserviceaccount.com" \
  --add-cloudsql-instances "${PROJECT}:${REGION}:${INSTANCE}" \
  --no-allow-unauthenticated \
  --port 3000 \
  --cpu 1 \
  --memory 512Mi \
  --min-instances 0 \
  --max-instances 3 \
  --concurrency 80 \
  --set-secrets "PGRST_DB_URI=pgrst-db-uri:latest,PGRST_JWT_SECRET=pgrst-jwt-secret:latest" \
  --set-env-vars "^|^PGRST_DB_SCHEMAS=public|PGRST_DB_ANON_ROLE=anon|PGRST_DB_EXTRA_SEARCH_PATH=public,extensions|PGRST_DB_MAX_ROWS=1000|PGRST_DB_POOL=8|PGRST_SERVER_PORT=3000|PGRST_LOG_LEVEL=warn"
