# Service Line Portfolio Tracker

Internal app for Cardiac Procedure Services (CaroMont Health). Tracks every project across the
cardiac service line and produces a biweekly PDF status report (one project per row, not SBAR).
Sign-in is required for every page.

**Status:** local scaffold. Not yet pushed to GitHub or deployed to Vercel.

## Stack

- Next.js 16 (App Router, TypeScript), Tailwind CSS v4, dark theme by default
- Prisma 7 + PostgreSQL via `@prisma/adapter-pg` (works with Vercel Postgres / Neon using `DATABASE_URL`)
- Auth.js (`next-auth@5` beta), Google sign-in, JWT sessions, email allowlist, admin role
- Vitest for unit tests
- Node 20.19+ (Prisma 7 requirement)

## Quick start

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env.local  # fill in DATABASE_URL, AUTH_SECRET, AUTH_GOOGLE_*, ALLOWED_EMAILS
npx prisma migrate deploy   # apply prisma/migrations to the database
npm run db:seed             # OPTIONAL, local only: 10 fictional "Sample:" projects
npm run dev
```

Local sign-in uses Google too: add `http://localhost:3000/api/auth/callback/google` to the OAuth
client (see [Google OAuth setup](#google-oauth-setup)) and put your address in `ALLOWED_EMAILS` or
`ADMIN_EMAILS`.

No local Postgres? Any of these work: a free Neon branch, `npx prisma dev` (local Prisma Postgres),
or Docker `postgres:16`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | `prisma generate && next build` |
| `npm run lint` | ESLint (next/core-web-vitals + TypeScript) |
| `npm run typecheck` | `prisma generate && tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run db:migrate` | `prisma migrate deploy` (use in CI / Vercel build) |
| `npm run db:migrate:dev` | `prisma migrate dev` (create new migrations locally) |
| `npm run db:seed` | Sample data (refuses in production or if projects exist) |

## Environment variables

See `.env.example` for the full annotated list.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (pooled URL on Vercel/Neon) |
| `AUTH_SECRET` | yes | `npx auth secret` or `openssl rand -base64 32`. Use a different value per environment |
| `AUTH_GOOGLE_ID` | yes | Google OAuth client ID (`...apps.googleusercontent.com`) |
| `AUTH_GOOGLE_SECRET` | yes | Google OAuth client secret. Server only, never commit it |
| `ALLOWED_EMAILS` | yes | Comma/space/semicolon separated emails or `@domain` entries. Trimmed, case-insensitive |
| `ADMIN_EMAILS` | no | Same format. These people may sign in (even if not on `ALLOWED_EMAILS`) and are admins. Empty = no admins |
| `AUTH_TRUST_HOST` / `AUTH_URL` | no | Not needed on Vercel (see below). Set `AUTH_TRUST_HOST=true` for self-hosted `next start` behind a proxy |

If `ALLOWED_EMAILS` and `ADMIN_EMAILS` are both empty, nobody can sign in (fails closed).

**trustHost on Vercel:** Auth.js v5 trusts the request host automatically when the `VERCEL` system
env var is present (it is on every Vercel deployment), so do not set `AUTH_URL` or `AUTH_TRUST_HOST`
there. Setting `AUTH_URL` would pin every deployment (including previews) to one origin. Off Vercel
in production, set `AUTH_TRUST_HOST=true` (or `AUTH_URL`) or Auth.js rejects the host.

## Google OAuth setup

The Auth.js route lives at `src/app/api/auth/[...nextauth]/route.ts` and uses the default `basePath`
`/api/auth` (no `AUTH_URL` path override), so Google's callback path is `/api/auth/callback/google`.

1. Open https://console.cloud.google.com/ and sign in with the Google account that will own the app.
2. **Create a project:** project picker (top bar) > **New project** > name it (for example
   `caromont-portfolio-tracker`) > **Create**, then select it.
3. **OAuth consent screen:** **APIs & Services** > **OAuth consent screen** (in newer consoles:
   **Google Auth Platform** > **Branding / Audience**) > **Get started**.
   - App name `Service Line Portfolio Tracker`, user support email and developer contact email: your address.
   - User type / Audience: **External**.
   - Scopes: the defaults are enough (`openid`, `email`, `profile`); no sensitive scopes are needed.
   - While the publishing status is **Testing**, go to **Audience** > **Test users** > **Add users**
     and add your own address (and anyone else who needs to sign in). Only test users can sign in
     while in Testing. Alternatively click **Publish app**; basic scopes need no verification.
4. **OAuth client ID:** **APIs & Services** > **Credentials** (or **Google Auth Platform** >
   **Clients**) > **Create credentials** > **OAuth client ID**.
   - Application type: **Web application**. Name: `portfolio-tracker web`.
   - **Authorized JavaScript origins:**
     - `https://caromont-portfolio-tracker-nleary-2832.vercel.app`
     - `http://localhost:3000` (optional, local dev)
   - **Authorized redirect URIs:**
     - `https://caromont-portfolio-tracker-nleary-2832.vercel.app/api/auth/callback/google`
     - `http://localhost:3000/api/auth/callback/google`
   - **Create.**
5. Copy the **Client ID** into `AUTH_GOOGLE_ID` and the **Client secret** into `AUTH_GOOGLE_SECRET`
   (`.env.local` locally; Vercel > Project > Settings > Environment Variables in production), together
   with `AUTH_SECRET`, `ALLOWED_EMAILS` and `ADMIN_EMAILS`. Redeploy after changing Vercel env vars.
6. Sign in at `/signin` with **Sign in with Google**. An address on neither list, or one Google has
   not verified, sees "This account is not on the access list." and nothing else.

Google can take a few minutes to apply redirect URI changes. A `redirect_uri_mismatch` error means the
URI above does not exactly match what is registered (scheme, host, path, no trailing slash).
Preview deployments have their own hostnames and are not registered, so Google sign-in only works on
the production domain and localhost.

## Auth model

- `src/proxy.ts` (Next 16 renamed `middleware.ts` to `proxy.ts`) runs Auth.js on every route except
  `/signin`, `/api/auth/*` and static assets. The `authorized` callback re-checks the allowlist on each
  request, so removing someone from `ALLOWED_EMAILS` / `ADMIN_EMAILS` locks them out without waiting for session expiry.
- Google is the only provider (`src/lib/auth/AuthProviders.ts`).
- `signIn` callback (`SignInPolicy.allowSignIn`) requires Google, `email_verified === true`, and an
  email on `ALLOWED_EMAILS` or `ADMIN_EMAILS` (trimmed, case-insensitive). Denied users only see
  "This account is not on the access list."
- Admin: `SignInPolicy.isAdmin` (email on `ADMIN_EMAILS`), recomputed on every request and exposed as
  `session.user.isAdmin`. It is never stored in the JWT.
- Pages also call `auth()` themselves (defense in depth; do not rely on the proxy alone).
- Sessions: JWT, 8 hour max age. No user table.

## Data model (prisma/schema.prisma)

- `ServiceArea`: Cath, EP, Echo, CVSS, INU, CardioNeuro, IR (this is the report order).
- `ProjectStatus`: NotStarted, OnTrack, AtRisk, OffTrack, OnHold, Complete, Cancelled
  (labels in `ProjectStatusInfo`).
- `Project`: soft delete only (`archivedAt`); `closedReportedAt` is set when a Complete/Cancelled
  project first appears in a snapshot, after which it drops off later reports.
- `ProjectHistory`: append-only audit trail.
- `ReportSnapshot`: immutable; frozen `rowsJson`, `missingChampionsJson`; write-once
  `pdfStorageKey`, `sentAt`, `sentToJson`.
- `Recipient`: unique email; `serviceArea` null = all areas; `line` To/Cc; deactivate, never delete.

### Guarantees and where they are enforced

| Rule | App | Database (migration 0001) |
| --- | --- | --- |
| Note max 200 chars | `ProjectValidator` using `AppConfig.NOTE_MAX_LENGTH` | (none, by design: single constant) |
| Next milestone required unless Complete/Cancelled | `ProjectValidator` | CHECK constraint |
| Percent complete 0 to 100 | `ProjectValidator` | CHECK constraint |
| History written in the same transaction | `ProjectService` (only write path) | n/a |
| History append-only | no update/delete code paths | trigger blocks UPDATE/DELETE |
| No hard delete of projects/recipients | no delete code paths | trigger blocks DELETE |
| Snapshot immutable | no edit code paths | trigger blocks edits; delivery fields write-once |

The CHECK constraints and triggers are hand-written SQL appended to the generated
`prisma/migrations/0001_init/migration.sql` (generated with
`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`). Verified by applying it
to a PGlite Postgres instance and exercising the services and guards.

## Domain logic (src/lib, classes with static methods)

- `ProjectValidator`: validation/normalization (zod). Enums only, note limit, milestone rule, 0 to 100.
- `ProjectService`: `create`, `update`, `archive`, `completeMilestone`, `markClosedReported`. Every
  mutation writes `ProjectHistory` rows in the same transaction. No-op updates write nothing.
  Reopening a reported closed project clears `closedReportedAt` (so its later closure is reported).
  - `completeMilestone(id, { nextMilestone, dueDate, note?, markComplete? }, actor)`: "Milestone met".
    Writes a `milestone_completed` history row (oldValue = `"<previous milestone> (due YYYY-MM-DD)"`),
    then sets the new milestone and due date (both required unless `markComplete`, which sets status
    Complete), plus normal field-level history rows, all in one transaction.
- `ReportBuilder`: row selection, Changed/Overdue flags, sort order, `build()`.
  - Selection: `includeInReport`, not archived, and not (Complete/Cancelled with `closedReportedAt` set).
  - Changed: any history row after the previous snapshot's `generatedAt` (first report: any history).
  - Overdue: due date before the report date (America/New_York calendar date) and not Complete/Cancelled.
  - Sort: service area order, then severity (Off track, At risk, On hold, On track, Not started,
    Complete, Cancelled), then due date ascending with nulls last, then name.
- `ChampionCheck`: champions on active projects (not archived, not Complete/Cancelled) with no active
  Recipient, matched by email when the champion has one, otherwise case-insensitive name. Stored on
  the snapshot. Never adds recipients.
- `SnapshotService.create`: serializable transaction that builds rows, stores the snapshot and marks
  newly reported closed projects.
- `DashboardViewModel`: dashboard rows, tile counts, filters.
- `AppConfig`: single constants (note limit 200, time zone).

## UI

Design source: `/workspace/portfolio-tracker-mockups` (dashboard.png, report.png, tokens.css).
`src/styles/tokens.css` is a copy of the mockup tokens (font URL pointed at `/fonts/Inter-Variable.ttf`)
and is exposed to Tailwind as theme colors (`bg-card`, `text-muted`, `border-line`, ...) and type
utilities (`type-table`, `type-label`, ...). Status pill / flag / chip classes are ported from
`dashboard.css`.

- `/signin`: a single "Sign in with Google" button and the generic access-denied message.
- `/`: status and flag tiles, service-area filter chips, search (`/` shortcut), one row per project,
  detail drawer. Copy avoids em dashes.

## Stubbed / not built yet

- PDF generation (`PdfReportRenderer.render` returns no storage key). "Generate report" button is disabled.
- History timeline in the drawer, project create/edit forms, recipient management, sending email.
- Report period picker in the top bar (shows latest snapshot only).

## PDF report spec (for the renderer; constants in `src/lib/report/PdfReportLayout.ts`)

- Title: **"Cardiac Service Line: Project Status Report"** (no em dashes in report copy).
- Light theme, US Letter **landscape**, 0.5 in side margins (10.0 in content width).
- Grouped by service area (report order), with a section header per area.
- Two-line rows. Line 1 columns (inches): Project 2.2, Owner 1.0 (physician champion in small gray
  under the owner), Status 0.85, Next milestone 2.0, Due 0.6, Flags 3.35.
- Line 2: the note, starting under Next milestone and running to the right margin (5.95 in), clipped
  to two lines. A 200-char note fits in two lines at the report table size (see mockup `measurement.json`).
- Rows never split across pages.
- Every page repeats the header: report date, period covered, status counts per service area.
- Pages are numbered ("Page X of Y").
- Flags are text plus color so they read in black and white: Changed = outlined, Overdue = solid.
- Use the light status/flag tokens (`--status-*-light-*`, `--flag-*-light-*`) and report type scale.

## Deploying later (not done)

1. Create the GitHub repo and push. 2. Import into Vercel, add a Postgres (Neon) integration.
3. Set env vars above. 4. Run `prisma migrate deploy` (build step or one-off). 5. Register the
Google redirect URIs (see [Google OAuth setup](#google-oauth-setup)).
