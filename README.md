# Service Line Portfolio Tracker

Internal app for Cardiac Procedure Services (CaroMont Health). Tracks every project across the
cardiac service line and produces a biweekly PDF status report (one project per row, not SBAR).
Sign-in is required for every page.

**Status:** scaffold on GitHub; hosted on Vercel (project `caromont-portfolio-tracker`). See "Deploying on Vercel".

## Stack

- Next.js 16 (App Router, TypeScript), Tailwind CSS v4, dark theme by default
- Prisma 7 + PostgreSQL via `@prisma/adapter-pg` (works with Vercel Postgres / Neon using `DATABASE_URL`)
- Auth.js (`next-auth@5` beta), JWT sessions, email allowlist, pluggable providers
- Vitest for unit tests
- Node 20.19+ (Prisma 7 requirement)

## Quick start

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env.local  # fill in DATABASE_URL, AUTH_SECRET, ALLOWED_EMAILS, a provider
npx prisma migrate deploy   # apply prisma/migrations to the database
npm run db:seed             # OPTIONAL, local only: 10 fictional "Sample:" projects
npm run dev
```

For local sign-in without SSO, set `AUTH_DEV_LOGIN=true` (only works when `NODE_ENV` is not
`production`; still limited to `ALLOWED_EMAILS`).

No local Postgres? Any of these work: a free Neon branch, `npx prisma dev` (local Prisma Postgres),
or Docker `postgres:16`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | `prisma generate && next build` |
| `npm run build:vercel` | Vercel build (`scripts/vercel-build.sh`): generate, `migrate deploy` when safe, build |
| `npm run lint` | ESLint (next/core-web-vitals + TypeScript) |
| `npm run typecheck` | `prisma generate && tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run db:migrate` | `prisma migrate deploy` (run automatically by the Vercel build; see below) |
| `npm run db:migrate:dev` | `prisma migrate dev` (create new migrations locally) |
| `npm run db:seed` | Sample data (refuses in production or if projects exist) |

## Environment variables

See `.env.example` for the full annotated list.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string used by the app at runtime (pooled URL on Vercel/Neon) |
| `DATABASE_URL_UNPOOLED` | recommended on Neon | Direct (non-pooled) URL used by the Prisma CLI (`migrate deploy`/`dev`). Falls back to `DATABASE_URL` if unset. Set automatically by the Vercel Neon integration |
| `AUTH_SECRET` | yes | `npx auth secret` or `openssl rand -base64 32` |
| `ALLOWED_EMAILS` | yes | Comma/space separated emails or `@domain` entries. Empty = nobody (fails closed) |
| `ADMIN_EMAILS` | no | Same format. Admins (must also be allowlisted) change view settings, hide/delete projects, open `/admin/audit`. Empty = no admins (fails closed) |
| `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` | optional | Enables Microsoft sign-in. Use the tenant-specific issuer |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | optional | Enables Google sign-in |
| `AUTH_DEV_LOGIN` | optional | `true` enables the email-only dev form (never in production) |
| `AUTH_TRUST_HOST` / `AUTH_URL` | optional | Only needed off Vercel |

OAuth redirect URIs: `https://<domain>/api/auth/callback/microsoft-entra-id` and
`https://<domain>/api/auth/callback/google`.

## Deploying on Vercel

- `main` deploys to Production; every PR gets a Preview deployment (Git integration).
- `vercel.json` sets the build command to `sh scripts/vercel-build.sh`, which runs
  `prisma generate`, then `prisma migrate deploy`, then `next build`.
- Migrations run only when `DATABASE_URL_UNPOOLED` or `DATABASE_URL` is set and the deployment is Production, or when
  `PRISMA_MIGRATE_ON_PREVIEW=true` is set for Preview. Only set that when Preview has its own
  database (for example a Neon branch per preview); otherwise PR migrations would hit the production DB.
- `prisma migrate deploy` uses the direct connection `DATABASE_URL_UNPOOLED` when present
  (`prisma.config.ts`), because migrations over Neon's PgBouncer pooler can fail (advisory locks,
  prepared statements). The running app keeps using the pooled `DATABASE_URL` via `@prisma/adapter-pg`;
  no `pgbouncer=true` flag is needed with driver adapters.
- All secrets live in Vercel Project Settings > Environment Variables, never in the repo.

## Auth model

- `src/proxy.ts` (Next 16 renamed `middleware.ts` to `proxy.ts`) runs Auth.js on every route except
  `/signin`, `/api/auth/*` and static assets. The `authorized` callback re-checks the allowlist on each
  request, so removing someone from `ALLOWED_EMAILS` locks them out without waiting for session expiry.
- `signIn` callback enforces `ALLOWED_EMAILS` for every provider (`EmailAllowlist`).
- Admin role: `AdminPolicy` reads `ADMIN_EMAILS` on every request (`CurrentViewer.get()` in pages and
  Server Actions; services assert admin again). Only admins can change view settings, hide projects, or
  delete/restore projects. The View picker, its badge, the Audit link and every hide/delete control are
  rendered only for admins, and non-admins' page payload carries no admin props at all.
- `/admin/audit` returns a 404 (not 403) to non-admins so its existence is not revealed.
- Pages also call `auth()` themselves (defense in depth; do not rely on the proxy alone).
- Providers are registered in `src/lib/auth/AuthProviders.ts`; add a descriptor there to plug in another.
- Sessions: JWT, 8 hour max age. No user table.

## Data model (prisma/schema.prisma)

- `ServiceArea`: Cath, EP, Echo, CVSS, INU, CardioNeuro, IR (this is the report order).
- `ProjectStatus`: NotStarted, OnTrack, AtRisk, OffTrack, OnHold, Complete, Cancelled
  (labels in `ProjectStatusInfo`).
- `Project`: soft delete only (admin "Delete" sets `archivedAt` + `deletedBy`; the DB blocks hard deletes;
  record and history are kept). Admin per-project hide: `hiddenFromDashboard`, `hiddenFromReport`
  (migration 0003). `closedReportedAt` is deprecated and unused (kept so no data is dropped).
- `ProjectHistory`: append-only audit trail. Hide/unhide/delete/restore changes are recorded here too
  (fields `hiddenFromDashboard`, `hiddenFromReport`, `archivedAt`, `deletedBy`) and are admin-only.
- `ReportSnapshot`: immutable; stores only what was visible in the report view at freeze: `rowsJson`,
  `headerJson` (counts from visible rows only), `missingChampionsJson` (visible rows only). Also
  `viewSettingsJson` (report view settings at freeze, ADMIN-ONLY, never rendered to non-admins); write-once
  `pdfStorageKey`, `sentAt`, `sentToJson`.
- `Recipient`: kept in the schema, but nothing drives sending from it (the report email goes to Nick's
  work email only). Unique email; `serviceArea` null = all areas; `line` To/Cc; deactivate, never delete.
- `view_settings` (`ViewSettings`): one global row per context (`dashboard`, `report`) with `columnOrder`,
  `hiddenColumns`, `hiddenStatuses`. Seeded by migration 0002 (Complete and Cancelled hidden). Never deleted.
- `view_settings_history` (`ViewSettingsHistory`): append-only audit of every change (who, when, old, new).

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
| deletedBy only on soft-deleted projects | `ProjectService.softDelete/restore` | CHECK constraint (migration 0003) |
| Hide/delete/restore/view settings are admin-only | `AdminPolicy` in Server Actions and services | n/a |
| View settings history append-only | `ViewSettingsService` only creates | trigger blocks UPDATE/DELETE (migration 0002) |

The CHECK constraints and triggers are hand-written SQL appended to the generated
`prisma/migrations/0001_init/migration.sql` (generated with
`prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`). Verified by applying it
to a PGlite Postgres instance and exercising the services and guards.

## Domain logic (src/lib, classes with static methods)

- `ProjectValidator`: validation/normalization (zod). Enums only, note limit, milestone rule, 0 to 100.
- `ProjectService`: `create`, `update`, `completeMilestone`, and admin-only `softDelete`, `restore`,
  `setHidden(id, context, hidden)`. Every
  mutation writes `ProjectHistory` rows in the same transaction. No-op updates write nothing.
  - `completeMilestone(id, { nextMilestone, dueDate, note?, markComplete? }, actor)`: "Milestone met".
    Writes a `milestone_completed` history row (oldValue = `"<previous milestone> (due YYYY-MM-DD)"`),
    then sets the new milestone and due date (both required unless `markComplete`, which sets status
    Complete), plus normal field-level history rows, all in one transaction.
- `ReportBuilder`: row selection, Changed/Overdue flags, sort order, `build()`.
  - Rows: `VisibilityPolicy.visibleProjects(projects, "report", settings)`.
  - Header: status counts overall and per area, overdue and changed, all computed from the rows, so they
    always add up to the rows. There is no "Hidden: ..." line.
  - Changed: any non-admin history row after the previous snapshot's `generatedAt` (first report: any
    history). Hide/delete events never set it.
  - Overdue: due date before the report date (America/New_York calendar date) and not Complete/Cancelled.
  - Sort: service area order, then severity (Off track, At risk, On hold, On track, Not started,
    Complete, Cancelled), then due date ascending with nulls last, then name.
- `VisibilityPolicy` (`src/lib/visibility`): THE central visibility gate. Deleted projects, projects hidden
  per context, and projects whose status is hidden are invisible to non-admins and excluded from every
  count, total, tile, chip count, report header count, flag and history view. History of invisible
  projects and hide/delete events are admin-only; `snapshotForViewer` strips the frozen view settings.
  Every read path (dashboard, report, snapshot, history, audit) uses it; future exports, handoff.json and
  agendas must build on it too.
- `ProjectHistoryService.forProject(id, viewer)`: the history read path (filtered for non-admins).
- `AdminAuditService.load(viewer)`: hidden and deleted projects, view settings, and recent admin-only
  changes (who, when, old, new) for `/admin/audit`; `notFound()` for non-admins.
- `ChampionCheck`: champions on active projects (not archived, not Complete/Cancelled) with no active
  Recipient, matched by email when the champion has one, otherwise case-insensitive name. Stored on
  the snapshot (computed on visible rows only, since it names projects). Never adds recipients.
- `SnapshotService.create`: serializable transaction that reads the report view settings, builds rows
  and header from visible rows, and stores them plus the (admin-only) settings in the immutable snapshot.
- `ViewSettings` (pure): defaults, normalization, locked columns (Project, Status), toggles, reorder. `ViewSettingsService`: `get`, `getAll`, `update`, `reset`; writes history per change.
- `DashboardViewModel`: dashboard rows (through `VisibilityPolicy`), tile counts from those rows,
  filters, admin-only picker counts.
- `AppConfig`: single constants (note limit 200, time zone).

## UI

Design source: `/workspace/portfolio-tracker-mockups` (dashboard.png, report.png, tokens.css).
`src/styles/tokens.css` is a copy of the mockup tokens (font URL pointed at `/fonts/Inter-Variable.ttf`)
and is exposed to Tailwind as theme colors (`bg-card`, `text-muted`, `border-line`, ...) and type
utilities (`type-table`, `type-label`, ...). Status pill / flag / chip classes are ported from
`dashboard.css`.

- `/signin`: provider buttons, access-denied message.
- `/`: status and flag tiles, service-area filter chips, search (`/` shortcut), one row per project,
  detail drawer. Copy avoids em dashes.
- View picker (ADMIN ONLY; `ViewSettingsPicker`, styles in `src/styles/view-picker.css`, design
  `picker.html`, code-split so non-admins never load it): Dashboard tab applies immediately; Report tab is a
  draft saved with "Save report view". Columns can be toggled and dragged (or moved with arrow keys on the
  grip). Footnote: "Only you see this menu. Hidden items are left out of every count, flag, and export
  that others see."
- Drawer admin controls (ADMIN ONLY, `ProjectAdminControls`): Hide from dashboard, Hide from report,
  Delete project (soft, with confirm).
- `/admin/audit` (ADMIN ONLY, 404 for everyone else): hidden and deleted projects with Unhide/Restore
  (which write audit rows), view settings in effect, and recent admin changes.
- All admin mutations are Server Actions in `src/app/actions/admin.ts`, which re-check admin per call.

## Stubbed / not built yet

- PDF generation (`PdfReportRenderer.render` returns no storage key). "Generate report" button is disabled.
- handoff.json (not built yet). Rules for when it is: build it on `VisibilityPolicy` from the frozen
  snapshot; flags are computed only on rows visible in the frozen report view (snapshot `rowsJson`).
  The report email goes to Nick's work email only, so handoff.json carries no To/Cc lists; the Recipient
  table stays in the schema but nothing drives sending from it. Missing champions come from the snapshot's
  `missingChampionsJson`, which covers visible rows only.
- History timeline UI in the drawer (the filtered read path `ProjectHistoryService.forProject` exists),
  project create/edit forms, recipient management, sending email.
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
Entra ID redirect URI for the production domain.
