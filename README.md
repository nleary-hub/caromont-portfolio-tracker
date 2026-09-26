# Service Line Portfolio Tracker

Internal app for Cardiac Procedure Services (CaroMont Health). Tracks every project across the
cardiac service line and produces a biweekly PDF status report (one project per row, not SBAR).
Sign-in is required for every page.

**Status:** local scaffold. Not yet pushed to GitHub or deployed to Vercel.

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
| `npm run lint` | ESLint (next/core-web-vitals + TypeScript) |
| `npm run typecheck` | `prisma generate && tsc --noEmit` |
| `npm test` | Vitest unit tests |
| `npm run db:migrate` | `prisma migrate deploy` (use in CI / Vercel build) |
| `npm run db:migrate:dev` | `prisma migrate dev` (create new migrations locally) |
| `npm run db:seed` | Sample data (refuses in production or if projects exist) |
| `npm run import:csv -- file.csv [--update-wording] [--commit] [--as admin@...]` | CSV import via `DATABASE_URL` (dry run unless `--commit`) |
| `npm run export:csv -- out.csv` | CSV export (id + template columns) of non-archived projects |

## Environment variables

See `.env.example` for the full annotated list.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (pooled URL on Vercel/Neon) |
| `AUTH_SECRET` | yes | `npx auth secret` or `openssl rand -base64 32` |
| `ALLOWED_EMAILS` | yes | Comma/space separated emails or `@domain` entries. Empty = nobody (fails closed) |
| `ADMIN_EMAILS` | no | Same format. Admins (must also be allowlisted) change view settings, hide/delete projects, open `/admin/audit` and `/admin/import`. Empty = no admins (fails closed) |
| `AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER` | optional | Enables Microsoft sign-in. Use the tenant-specific issuer |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | optional | Enables Google sign-in |
| `AUTH_DEV_LOGIN` | optional | `true` enables the email-only dev form (never in production) |
| `AUTH_TRUST_HOST` / `AUTH_URL` | optional | Only needed off Vercel |

OAuth redirect URIs: `https://<domain>/api/auth/callback/microsoft-entra-id` and
`https://<domain>/api/auth/callback/google`.

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
- `Project`: optional `description` (what the project is; migration `0010_project_description`; not shown
  in the UI or report yet); optional `inforRequestNumber` (DB column `infor_request_number`, migration
  `0011_project_infor_request_number`; whole number 1 to 99999, shown as "REQ-5081"; DB check constraint); soft delete only (admin "Delete" sets `archivedAt` + `deletedBy`; the DB blocks hard deletes;
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
| Next milestone max 40 chars | `ProjectValidator` using `AppConfig.MILESTONE_MAX_LENGTH` | (none, by design: single constant) |
| Description (optional) max 200 chars | `ProjectValidator` using `AppConfig.DESCRIPTION_MAX_LENGTH` | (none, by design: single constant) |
| Infor request number (optional) whole number 1 to 99999, blank = null | `ProjectValidator` using `AppConfig.INFOR_REQUEST_NUMBER_MIN/MAX` | CHECK constraint (migration 0011) |
| Next milestone required unless Not started/On hold/Complete/Cancelled (`ProjectStatusInfo.MILESTONE_OPTIONAL`, migration 0012) | `ProjectValidator` | CHECK constraint |
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
- `ChampionCheck`: requesters on active projects (not archived, not Complete/Cancelled) with no active
  Recipient, matched by email when a stored email exists, otherwise case-insensitive name. Rows marked
  Not applicable are never flagged. Stored on
  the snapshot (computed on visible rows only, since it names projects). Never adds recipients.
- `SnapshotService.create`: serializable transaction that reads the report view settings, builds rows
  and header from visible rows, and stores them plus the (admin-only) settings in the immutable snapshot.
- `ViewSettings` (pure): defaults, normalization, locked columns (Project, Status), toggles, reorder. `ViewSettingsService`: `get`, `getAll`, `update`, `reset`; writes history per change.
- `DashboardViewModel`: dashboard rows (through `VisibilityPolicy`), tile counts from those rows,
  filters, admin-only picker counts.
- `AppConfig`: single constants (note limit 200, time zone).
- `ProjectCsv`, `ImportService`, `ExportService` (src/lib/import): CSV template, parsing, dry run,
  all-or-nothing commit, export. Admin checks use `AdminPolicy` (via `AdminGate` for pages and routes).

## UI

Design source: `/workspace/portfolio-tracker-mockups` (dashboard.png, report.png, tokens.css).
`src/styles/tokens.css` is a copy of the mockup tokens (font URL pointed at `/fonts/Inter-Variable.ttf`)
and is exposed to Tailwind as theme colors (`bg-card`, `text-muted`, `border-line`, ...) and type
utilities (`type-table`, `type-label`, ...). Status pill / flag / chip classes are ported from
`dashboard.css`.

- `/signin`: provider buttons, access-denied message.
- `/`: status and flag tiles, service-area filter chips, search (`/` shortcut), one row per project,
  detail drawer. Copy avoids em dashes.
- Project meta line (small gray text under the project name, same row height): "REQ-5081", then "Updated Sep 24".
  The number is monospace, 9px, slightly brighter, left-aligned in a fixed slot (`DashboardMetaLine.INFOR_SLOT_WIDTH`,
  9ch, sized for "REQ-99999") followed by a fixed gap (`DashboardMetaLine.INFOR_GAP`, 8px), so "Updated" lines up
  on every row. No separator glyph. No number: blank slot plus gap (no dash). "Infor request # (REQ-, under
  Project)" hidden in the view settings: no slot and no gap, so "Updated" starts at the left edge. "Updated" is
  the latest public change (same rule as the report) and turns amber when stale; the number never does. The
  drawer shows the number; search matches "REQ-5081".
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

## CSV import and export (admin)

Admins (`ADMIN_EMAILS`, see `AdminPolicy`) get `/admin/import`; everyone else gets a 404 (page, Server
Functions and download routes all re-check server-side via `AdminGate`). There is no nav link yet; go to
the URL directly.

- **Template:** `docs/project-import-template.csv` (also "Download template" on the page). Columns:
  `name, description, infor_request_number, service_area, owner, requester, status, next_milestone,
  due_date, percent_complete, note, accomplishment, completed_on, include_in_report`. Required columns:
  `name, service_area, status` (a `department` header is read as `service_area`; a blank value or
  `Unassigned` means no department, shown as the Unassigned group, last). `owner` is optional
  (blank or missing = "To assign"); a blank `status` on a new project means On track. The two `Example:` rows are fake and are skipped.
  - `service_area`: Cath, EP, Echo, CVSS, INU, CardioNeuro, IR (also `Cath Lab` and `EP Lab`, `ServiceAreaInfo.ALIASES`). `status`: Not started, On track, At risk,
    Off track, On hold, Complete, Cancelled. Case and spaces do not matter (`on track`, `OnTrack`).
  - `due_date`: YYYY-MM-DD or M/D/YYYY. `percent_complete`: 0 to 100 (a trailing % is fine).
    `include_in_report`: yes/no (blank = yes). `description` is optional (blank is fine; the column
    may be left out). `infor_request_number` is optional: a whole number 1 to 99999 (surrounding spaces are
    fine; decimals, letters, signs, lists like "4656 / 5081", 0 and over 99999 are row errors). Blank = no
    number; the column may be left out, so older files still import and their new projects get no number.
    Export writes the plain number. `description` max 200, `note` max 200, `next_milestone` max 40 (`AppConfig`).
  - `accomplishment` (optional, max 200) and `completed_on` (optional date, same formats as `due_date`, display
    only) feed the report's "Completed this period" block; see docs/REPORTS.md.
  - `requester` (headers `physician_champion` and `champion` are read as `requester`): a name; `Not applicable`,
    `N/A` or `NA` (any case) marks it Not applicable (prints blank on the dashboard and report); blank = not yet
    addressed ("To assign" in gray). Export writes the name, `Not applicable` or blank. `physician_champion_email`
    is no longer imported (the preview notes it); stored emails are kept in the database but not shown.
  - `older_update` (added by Writing Bot) is recognized but not imported: the app has no place for older
    updates yet, so the preview shows a warning and the values are ignored. `owner_suggested` and `department_basis`
    are reference columns: never read, the preview notes that they are not imported.
- **New projects mode:** every row is validated with `ProjectValidator`; the preview shows per-row errors.
  Rows matching a non-archived project by (name, service area), ignoring case and extra spaces, are
  skipped with a warning and never overwritten. "Import N projects" is all-or-nothing in one
  transaction, through `ProjectService`, so each project gets its `created` history row
  (`changedBy` = the admin, `comment` = `csv_import`). Any row error blocks the whole import.
- **Wording update mode** (the Writing Bot round-trip): "Export CSV" (or `npm run export:csv`) writes
  `id` + the template columns for non-archived projects. Edit `description` / `note` / `next_milestone` / `accomplishment`,
  then upload with the wording option (or `--update-wording`). Rows match by `id` only. If any other
  column differs from the database, the row is rejected. `description` may be left out of a wording
  file (it is then unchanged); `id`, `note` and `next_milestone` columns are required (the value may be blank for Not started, On hold, Complete, Cancelled). `infor_request_number` is a
  data field, not wording: a wording file may leave the column out (unchanged) or carry the exported value,
  but changing it rejects the row (same for `completed_on`). The preview shows old versus new per row; commit is all-or-nothing
  through `ProjectService.updateInTx`, writing field history rows with `comment` = `csv_wording_update`.
- **CLI:** `npm run import:csv -- file.csv` is a dry run; add `--commit --as admin@...` (or set
  `IMPORT_ACTOR_EMAIL`) to save. The actor must be in `ADMIN_EMAILS`. Loads `.env.local`, then `.env`.

## Report PDF, freeze and delivery

See [docs/REPORTS.md](docs/REPORTS.md): renderer (`@react-pdf/renderer`, embedded Inter), biweekly freeze
(`/api/cron/freeze`, Vercel cron), handoff.json, Google Drive delivery with a signed-link fallback, the
`/reports` archive, the admin "Freeze now" and "Generate PDF now" (draft) actions, and the env vars.

## Not built yet

- History timeline UI in the drawer (the filtered read path `ProjectHistoryService.forProject` exists),
  project create/edit forms, recipient management. The app never sends email: handoff.json is for the
  person who sends it.
- Admin toggle for the optional "Next:" line on report rows (deferred).

## PDF report spec (for the renderer; constants in `src/lib/report/PdfReportLayout.ts`)

- Title: **"Cardiac Service Line: Project Status Report"** (no em dashes in report copy).
- Light theme, US Letter **landscape**, 0.5 in side margins (10.0 in content width).
- Grouped by service area (report order), with a section header per area.
- Two-line rows. Line 1 columns (inches): Project 2.2, Owner 1.35 (requester and "Contracts <name>" in small gray
  under the owner; the requester line is dropped when it is Not applicable), Status 0.85, Next milestone 2.0, Due 0.6,
  Flags 3.0. The owner column is 1.0 plus 0.35 for the contracts line, taken from Flags (`PdfReportLayout`).
- Line 2: the note, starting under Next milestone and running to the right margin (5.6 in),
  wrapping to as many lines as needed (never cut off; the row grows). A 200-char note fits in two lines; with the
  "No change." prefix it takes three.
- Rows never split across pages.
- Page 1 shows "Completed FY27 to date N" (teal check and number) beside the Projects line; see docs/REPORTS.md.
- Every page repeats the header: page 1 has the full meta block and per-area status grid; later pages
  have a running head (title, report date, period) and a one-line per-area status count strip.
- Pages are numbered ("Page X of Y").
- Flags are text plus color so they read in black and white: Changed = outlined, Overdue = solid.
- Status pills carry a shape (`StatusShapes`), also on the dashboard pills. Cancelled has no strikethrough
  (the X shape carries it, per status-shapes.html).
- Use the light status/flag tokens (`--status-*-light-*`, `--flag-*-light-*`) and report type scale.

## Deploying later (not done)

1. Create the GitHub repo and push. 2. Import into Vercel, add a Postgres (Neon) integration.
3. Set env vars above. 4. Run `prisma migrate deploy` (build step or one-off). 5. Register the
Entra ID redirect URI for the production domain.
