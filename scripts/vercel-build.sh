#!/bin/sh
# Vercel build: prisma generate, then migrations (when safe), then next build.
#
# Migrations (`prisma migrate deploy`) run only when a database URL is set AND either:
#   - this is not a Preview deployment (VERCEL_ENV != "preview"), i.e. Production, or
#   - PRISMA_MIGRATE_ON_PREVIEW=true is set for Preview.
# Set PRISMA_MIGRATE_ON_PREVIEW=true only when Preview has its OWN database (for example a Neon
# branch per preview). Otherwise a PR branch's migrations would be applied to the production DB.
#
# Connection used for migrations: DATABASE_URL_UNPOOLED (direct, set by the Vercel Neon
# integration) when present, else DATABASE_URL. The selection happens in prisma.config.ts so
# local `npm run db:migrate` behaves the same. The runtime app always uses pooled DATABASE_URL.
# Only variable NAMES are logged here, never values.
set -eu

npx prisma generate

if [ -n "${DATABASE_URL_UNPOOLED:-}" ]; then
  MIGRATE_URL_VAR="DATABASE_URL_UNPOOLED"
elif [ -n "${DATABASE_URL:-}" ]; then
  MIGRATE_URL_VAR="DATABASE_URL"
else
  MIGRATE_URL_VAR=""
fi

if [ -z "$MIGRATE_URL_VAR" ]; then
  echo "vercel-build: neither DATABASE_URL_UNPOOLED nor DATABASE_URL set; skipping prisma migrate deploy."
elif [ "${VERCEL_ENV:-}" = "preview" ] && [ "${PRISMA_MIGRATE_ON_PREVIEW:-}" != "true" ]; then
  echo "vercel-build: Preview deployment without PRISMA_MIGRATE_ON_PREVIEW=true; skipping prisma migrate deploy."
else
  echo "vercel-build: running prisma migrate deploy via ${MIGRATE_URL_VAR} (VERCEL_ENV=${VERCEL_ENV:-unset})."
  npx prisma migrate deploy
fi

npx next build
