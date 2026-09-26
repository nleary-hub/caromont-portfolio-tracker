#!/bin/sh
# Vercel build: prisma generate, then migrations (when safe), then next build.
#
# Migrations (`prisma migrate deploy`) run only when DATABASE_URL is set AND either:
#   - this is not a Preview deployment (VERCEL_ENV != "preview"), i.e. Production, or
#   - PRISMA_MIGRATE_ON_PREVIEW=true is set for Preview.
# Set PRISMA_MIGRATE_ON_PREVIEW=true only when Preview has its OWN database (for example a Neon
# branch per preview). Otherwise a PR branch's migrations would be applied to the production DB.
set -eu

npx prisma generate

if [ -z "${DATABASE_URL:-}" ]; then
  echo "vercel-build: DATABASE_URL not set; skipping prisma migrate deploy."
elif [ "${VERCEL_ENV:-}" = "preview" ] && [ "${PRISMA_MIGRATE_ON_PREVIEW:-}" != "true" ]; then
  echo "vercel-build: Preview deployment without PRISMA_MIGRATE_ON_PREVIEW=true; skipping prisma migrate deploy."
else
  echo "vercel-build: running prisma migrate deploy (VERCEL_ENV=${VERCEL_ENV:-unset})."
  npx prisma migrate deploy
fi

npx next build
