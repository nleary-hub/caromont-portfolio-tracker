# Biweekly report: PDF, freeze, handoff, delivery, archive

## Schedule

- Freeze every other Tuesday at 5 PM ET, first on **Tue 2026-09-29**. Constants in
  `src/lib/report/ReportSchedule.ts` (`ANCHOR_FREEZE_DATE`, `CADENCE_DAYS = 14`, `FREEZE_HOUR_ET = 17`).
- Period = previous freeze date to the freeze date (first period: Sep 15 to Sep 29, 2026).
- The report email goes out the next morning (Wed 8 AM ET). The app sends nothing; the sender works from
  handoff.json.

## Cron (Vercel Hobby)

`vercel.json` has two daily crons on the same path:

| Schedule (UTC) | ET in summer (EDT) | ET in winter (EST) |
| --- | --- | --- |
| `0 21 * * *` | 5 PM, freezes on freeze days | 4 PM, no-op |
| `0 22 * * *` | 6 PM, no-op (or catch-up) | 5 PM, freezes on freeze days |

Hobby crons run at most daily and fire anywhere inside the scheduled hour, so **the freeze can land
anywhere between 5:00 and 6:00 PM ET**. The code, not the schedule, decides: `ReportSchedule.dueFreezeDate`
targets the latest freeze date whose 5 PM ET has passed, and every other run is a no-op. Runs are
idempotent per period (unique `periodStart + periodEnd`; PDF, handoff.json and delivery are each done only
if missing), so extra runs are safe.

Manual backstop (same code path):

```sh
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<production-host>/api/cron/freeze
```

The route answers 401 without the exact bearer and fails closed when `CRON_SECRET` is unset. Vercel sends
the bearer automatically for its own cron calls once `CRON_SECRET` is set in the project.

Admins also get **Freeze now** on `/reports` (with a confirm): freezes the due period if it is missing;
on a freeze day before 5 PM it freezes that day's period early; otherwise it refuses and names the next
freeze date.

`vercel.json` note: PR #2 (`chore/vercel-build`) also adds `vercel.json` (`framework`, `buildCommand`).
This branch adds only `$schema` + `crons`. Whichever merges second resolves by keeping all keys:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "buildCommand": "sh scripts/vercel-build.sh",
  "crons": [
    { "path": "/api/cron/freeze", "schedule": "0 21 * * *" },
    { "path": "/api/cron/freeze", "schedule": "0 22 * * *" }
  ]
}
```

## What a freeze stores

1. `ReportSnapshot` (immutable): visible rows, header counts, report view settings and report options
   (`optionsJson`) at freeze. Built by `ReportDataLoader` through `VisibilityPolicy`.
2. `report_artifacts` (immutable, one per snapshot and kind): the PDF bytes and handoff.json bytes, with
   sha256. `pdfStorageKey` = `db:report_artifacts/<artifact id>` (write-once).
3. Delivery (below): every attempt appended to `report_deliveries`; the latest outcome on
   `ReportSnapshot.deliveryJson` (admin-only, shown on `/reports`). Also logged as JSON lines
   (`scope: "report"`) in the Vercel runtime logs.

## PDF

- `@react-pdf/renderer` (pure JS, runs in a Node serverless function, no headless Chrome). Static Inter
  instances (OFL) subset to Latin in `src/lib/report/fonts`, traced into the functions via
  `outputFileTracingIncludes` in `next.config.ts`.
- `ReportLayout` measures text with the same font files, wraps and clips it, sizes rows and paginates.
  The renderer draws the precomputed lines, so layout is unit-tested without rendering.
- US Letter landscape, 0.5 in margins, grouped by service area, two-line rows, spec column widths,
  note never cut off (wraps, the row grows), rows never split, section head kept with its first row and repeated with
  "(continued)", header on every page, "Page X of Y".
- Respects the frozen report view settings: column order, hidden columns (widths rescale to fill),
  hidden statuses (no grid column, no rows), per-project hide and soft delete (via `VisibilityPolicy`).
  Complete and Cancelled are hidden by default, so by default they get no column in the page 1 grid
  or the page 2+ count strip and are not counted anywhere (area totals, All areas, "Projects: N across
  M", Overdue, Changed, Stale). Turning a status on in the report view settings adds its column and
  counts. `ReportLayout` recomputes every count from the listed rows, so counts always match the page.
- Project meta line: "REQ-5081" in built-in Courier 6.5 pt, left-aligned in a fixed slot
  (`ReportGeometry.INFOR_SLOT_W` = 9 x 0.6 x 6.5 = 35.1 pt, sized for "REQ-99999"), then a fixed gap
  (`ReportGeometry.INFOR_GAP` = 5 pt), then "Updated <date>" in 7 pt gray, so Updated lines up on every row.
  No separator glyph. No number: blank slot plus gap (no dash). Column hidden in the report view settings:
  no slot and no gap, Updated starts at the left edge. Stale amber is on the Updated date only.
  Snapshots frozen before migration 0011 have no number and print as before.
- Row details that exist in data today: "Updated <date>" (latest public change), "from <status>" with an
  arrow when the status moved since the last report (wraps under the pill, never truncated), "No
  change." for unchanged rows.
- Flags: Changed, Overdue, Stale. Stale means the "Updated <date>" is `AppConfig.STALE_AFTER_DAYS`
  or more days before the report date; the date turns amber. The page 1 legend, key page and
  handoff.json all read that one constant, so changing it updates them together. Never on Complete or Cancelled, and
  only on listed rows. Stale has its own grid column, legend line and key entry.
- Flag chips sit on line one of the Flags column, starting under the FLAGS header. Default layout: fixed slots
  in the order Changed, Overdue, Stale, one slot per kind that at least one listed row in the report has
  (`FlagSlots.used`), so a kind has the same x on every row and an empty slot stays blank. A report with only
  Stale flags puts Stale right under the header. Custom column layout: the row's chips pack left in that order.
- Optional last page: status and flag key (admin toggle on `/reports`, default on, audited in
  `report_options_history`, frozen per snapshot).
- Sample: `npx vite-node --config vitest.config.ts scripts/render-sample-report.mts out.pdf [--draft]`
  (fictional data from `SampleReportData`).

## Completed this period

A Complete project is listed once, in the first FROZEN report after it became Complete, then drops off.

- **Clock:** when the status became Complete in the app: the latest `ProjectHistory` status change to
  Complete, or the `created` entry (creation or CSV import) if it was created as Complete. `completedOn`
  (as entered) is display only and never decides the period.
- **Listed when:** status Complete, a report candidate (not deleted, not hidden from the report, included in
  the report), Complete at or before the freeze time, and `completionReportedAt` is null. Only while
  Complete is hidden in the report view settings (the default); if an admin shows Complete, those projects
  are regular rows and no block is drawn.
- **Once only:** the freeze sets `Project.completionReportedAt` on the listed projects in the same
  transaction that writes the snapshot (`ReportSnapshot.completedJson`). Drafts never mark. Re-running a
  freeze for a frozen period re-renders from `completedJson`, so the block is never lost. Reopening (status
  leaves Complete) clears `completionReportedAt`. `completionReportedAt` is new rather than reusing the
  retired `closedReportedAt`, which had different semantics and could hold stale values.
- **PDF:** a tinted block at the end of each department group (style constants in `CompletedBlockStyle`):
  name with the REQ slot, owner with requester, a check and the date (`completedOn`, else the in-app
  completion date), and the accomplishment (max 2 lines) from the Next milestone column. The block is never
  split across pages. The section head reads "2 projects · 2 completed this period". Page 1 no longer shows a
  period count (see "Completed FY to date"). Nothing here feeds the status grid, totals or the projects line.
- **Unassigned:** projects with no department form an "Unassigned" group after every department (section
  head and page 1 table row in secondary gray; the table row appears only when there is one). It is not
  counted as a department in "N projects across M departments" (its projects do count in N). The Completed
  block works there like in any other group.
- **Departments:** every value of the `ServiceArea` enum (schema order is report order). A department with no
  listed projects gets no section and no page 1 table row. Page 1 reads "N projects across M departments":
  N is every listed project (Unassigned included), M the departments with listed projects (singular forms
  for 1). The page 1 period label is "Reporting period"; pages 2+ read "Reporting period Sep 15–29, 2026
  (continued)" (`ReportFormat.dateRange`). handoff.json keeps its own lists and is unchanged.
- **handoff.json:** `completedThisPeriod: { count, projects: [{ name, serviceArea, completedOn, accomplishment }] }`.

## Completed FY to date

- Page 1: "[check] Completed FY27 to date N" beside the Projects line (or on its own line under it when it
  does not fit), in the teal accent with the number bold. It replaced the old "Completed this period N".
- Fiscal year starts on the first day of `AppConfig.FISCAL_YEAR_START_MONTH` (7 = July) and is named by the
  calendar year it ends in (Jul 1 2026 to Jun 30 2027 = FY27). `FiscalYear`, `CompletedFiscalYear`.
- Counts projects with status Complete whose completion date is between the FY start and the report date,
  inclusive. Completion date = `completedOn` when entered, else the day the status became Complete in the
  app (ProjectHistory, America/New_York). Report candidates only: deleted, hidden from the report and not
  included in the report never count; Cancelled is not Complete. Not once-only: a project counts in every
  report until the FY rolls over; reopening removes it.
- Frozen in `ReportSnapshot.headerJson.completedFiscalYear` (`{ label, start, count }`), so a frozen report
  never changes. Older snapshots have no field and show no count.
- Also on the dashboard summary strip (same rule, as of today) and in handoff.json as
  `completedFiscalYear: { label, fiscalYearStart, count }` (null for older snapshots).

## Requester

The person field shown as "Requester" (stored as `physicianChampion`) has three states: a name; Not
applicable (`requesterNotApplicable`, prints blank on the dashboard and report, and its line is dropped from
the report owner stack); not yet addressed (blank, gray "To assign"). A name clears Not applicable and Not
applicable clears the name (validator plus a CHECK constraint). History records both fields.

## Draft PDF (admin "Generate PDF now")

`GET /api/reports/preview`, admin only (404 for everyone else). Same loader, builder, visibility gate,
report view settings, options and renderer as the freeze, on live data. The PDF is laid out exactly like a
frozen report (footer "Generated <date>, <time> ET"); only the file name says draft. Download only: no snapshot, no artifact,
no Drive call, no handoff.json, no archive entry, no audit row.

## handoff.json

`HandoffBuilder`: schemaVersion, title, snapshotId, reportDate, period (start, end, label), frozenAt
(UTC) and frozenAtEt, `reportRecipient` (from `REPORT_RECIPIENT_EMAIL`; omitted with a logged warning
when unset or not a single valid address), totals and per-area counts, flags (Changed, Overdue, Stale: counts
and the flagged projects), pdf (file name, sha256, size), `archiveUrl` (`<APP_BASE_URL>/reports`).
Visible rows only. No To/Cc and no missing-requester list.

## Delivery

- **Primary: Google Drive.** OAuth refresh token for Nick's own Google account, scope `drive.file`,
  plain `fetch` (no SDK). Uploads the PDF and handoff.json. Scope caveat: `drive.file` only sees files and
  folders the app created. Leave `GOOGLE_DRIVE_FOLDER_ID` empty and the app finds or creates its own
  folder "Cardiac Status Reports"; a folder made by hand in the Drive UI will not be writable.
- **Check Drive** (Admin > Report freeze, CVPSL, admins only; `POST /api/reports/drive-check`, 403 for anyone
  else): with the same settings and client as the freeze, saves a small plain text file named
  `portfolio-drive-setup-test-<timestamp>.txt` in the report folder, reads it back and deletes it. Nothing is
  frozen or sent. The result names the step that failed (save, read back, remove) with Drive's error text; it
  never returns a secret. Use it to confirm production Drive writes without waiting for a freeze.
- **Fallback: signed link** when Drive is unconfigured or fails. HMAC-SHA256 (`SHARE_LINK_SECRET`,
  at least 32 chars), expires after 7 days. `/api/share/<token>/pdf` and `/api/share/<token>/handoff`
  serve the files without app sign-in (excluded from the auth proxy); a bad, tampered or expired token
  gets 404. With no secret either, the delivery is recorded as failed and retried on the next run.
- A run re-attempts delivery when nothing was delivered, when everything failed, or when Drive is
  configured but the last delivery used the fallback link.
- **Vercel Deployment Protection** (on by default for Hobby preview and possibly production URLs)
  sits in front of the app and will block the signed link for anyone without a Vercel login, unless the
  `/api/share` path gets a protection bypass or the app is served from a custom domain without
  protection. This PR does not change protection settings.

## Archive

`/reports` (signed in): period, freeze time (ET), Download PDF. Admins also see delivery status, the
signed link, handoff.json downloads, Freeze now, the key-page toggle and Generate PDF now.

## Environment variables

| Name | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | No database exists on Vercel yet. Run `prisma migrate deploy` (PR #2's build script does this on production). |
| `CRON_SECRET` | `/api/cron/freeze` | Random, 32+ chars. Vercel adds the bearer to its cron calls. |
| `SHARE_LINK_SECRET` | signed fallback links | Random, 32+ chars. |
| `APP_BASE_URL` | absolute links in handoff.json and signed links | Falls back to `https://$VERCEL_PROJECT_PRODUCTION_URL`. |
| `REPORT_RECIPIENT_EMAIL` | handoff.json `reportRecipient` | One address. |
| `ADMIN_EMAILS` | Freeze now, draft PDF, delivery status | From PR #1. |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` | Drive upload | Needs a Google Cloud OAuth client (Nick's approval). Unset = fallback link. |
| `GOOGLE_DRIVE_FOLDER_ID` | Drive upload | Optional; see the drive.file caveat above. |

## Year-end report: summary grid and table

**Name.** A closed fiscal year is the "FY26 Year-End Report" (file `year-end-fy26-<date>.pdf`). The current, unfinished
fiscal year is the "FY27 Mid-Year Report" (file `mid-year-fy27-<date>.pdf`, runs through today). The title, file name,
PDF footer and Reports list row all use that name. The Generate dialog is still "Year-end report".

**Download only.** `YearEndReportService.generate` stores the PDF in the `year_end_report` table and the browser
downloads it from `/reports/year-end/<id>`. It never writes to Google Drive, never writes a handoff.json, never creates a
report artifact and never emails. The Wednesday email reads only what the weekly freeze delivers; the only Drive
upload is `ReportDeliveryService` (weekly). A test pins this.

**No Cancelled anywhere.** There's no Cancelled header total, grid column or section. The carried counts treat
Cancelled as closed, as before: a project cancelled on or before a boundary isn't counted there, and a currently
cancelled project is never Still in progress. (A project cancelled later was open at an earlier boundary, so it can be
in that year's Carried in.) Cancelled projects are still on the Cancelled page in the app. The report is the header,
the summary grid, then "Completed in FY N" and "Carried into FY N+1" (closed year) or "Still in progress" (current
year).

**Header totals and the summary grid** show the same totals in the same order (one list drives both):

| Report | Column 1 | Column 2 | Column 3 |
| --- | --- | --- | --- |
| Closed year (e.g. FY26) | Carried in from FY25 | Completed FY26 | Carried into FY27 |
| Current year (e.g. FY27) | Carried in from FY26 | Completed FY27 | Still in progress |

For the current year only, the Generate dialog has "Show in totals" checkboxes: Carried in from FY26, Completed FY27,
Still in progress (all checked by default, at least one required; with none checked, Generate is disabled and the hint
reads "Pick at least one."). Unchecked totals are left out of both the header and the grid; the rest keep the order
above. The Total row sums each column over departments. There is no sum across columns: the categories overlap (a
carried-in project can also be completed or still in progress). The selection is passed to the server action,
validated, and not saved; a missing selection means all three. A closed year always shows all three.

Rows: one per department that has a project in any shown column, in the line's department order (for CVPSL: Cath, EP,
Echo, CVSS, INU, CardioNeuro, IR), Unassigned last, plus Total. Empty departments are left out, as in the weekly
report; sections list only departments with projects, in the same order.

All counts use report candidates only (projects hidden from reports are left out), the same set as the tables.

- **Completed FY N**: unchanged. Complete with a completion date in the fiscal year (to date for the current year).
  Reopened projects aren't Complete, so they don't count.
- **Carried in from FY N-1**: projects open (not Complete or Cancelled) at the end of Jun 30 before the fiscal year.
- **Carried into FY N+1** (closed year): projects open at the end of Jun 30 of the fiscal year.
- **Still in progress** (current year): projects open today.

Carried in and Carried into are one shared computation (`YearEndReportData.openOn`) on the same day, so FY26's
"Carried into FY27" equals FY27's "Carried in from FY26", in total and per department (a test pins this).

"Open at the end of day D" is rebuilt as of D, so edits after D don't change it:

1. The project existed: created on or before D.
2. Closed now: open at D if its official close date (the completion date, or for a cancelled project the last
   Cancelled date in history) is after D, unless a status change on or before D shows it was already closed then.
3. Open now: its status at D rebuilt from project history was open. A project closed at D and reopened later counts
   as closed at D.

In the Carried table, a past year's row shows the status it had at D. When a project was only closed later by an
entered completion date and no status was on record for D, the status cell says "Open" in gray, not a guessed chip.

**Notes under the grid** (small gray text, left-aligned under the Total row):

- Always: "Carried in includes projects later closed without being completed. The other columns include projects
  started this year."
- **Tracking rule.** Project history only goes back to the first tracked day: the earliest project creation or history
  entry (Sep 26, 2026 in production, when the tracker's data was imported; imports don't set creation dates). A shown
  carried total whose boundary is before that prints a dash, in the grid and the header, never 0, with a note such as
  "Tracking started Sep 26, 2026, so Carried in from FY26 isn't available." (or "... so Carried into FY27 isn't
  available."). An empty Carried section then reads "Tracking started Sep 26, 2026, so this list isn't available."
  Still in progress is always known.

Empty lines: "No projects are still in progress." (current year) and "No projects carried into FY27." (closed year).

**Table columns (landscape Letter, 720 pt wide):** Project 206 to 184, Owner 116 to 100, Requester 116 to 100, Date or
Status 76 to 68, Final or Latest update 206 to 268. The update column wraps with no fixed line cap; the only guard is a
page-height limit (a single update longer than a full page is cut with an ellipsis, which only an imported update of
thousands of characters could reach). Rows never split across pages. Completed rows use the weekly report's completed
block shading (`CompletedBlockStyle`: fill, border and green left edge).
