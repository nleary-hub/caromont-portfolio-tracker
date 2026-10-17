# Changelog

Plain-language notes for Nick. Newest first.

## Unreleased: Tracker AI overhaul (draft PR, stacked on the per-feature AI provider PR)

### Project drawer: "Dependencies & blockers" (1a)
- The old "Dependencies" list in the project drawer is now "Dependencies & blockers", with a count of open items.
- Projects: "Blocked by" (projects this one waits on) and "Blocking" (projects waiting on this one). Each one can carry
  a short note, up to 120 characters, saying what exactly it is waiting on, and the milestone it holds up. Click a
  "Blocking" project to open it. Adding one that would make a loop is refused with a plain explanation.
- External: things outside the tracker (a vendor quote, a permit). Each has who it is waiting on, an optional
  follow-up date and owner, and the date it started. An overdue follow-up shows in amber.
- Resolving an outside blocker asks "What resolved it?". Resolved items are kept in a closed "Resolved" list; nothing
  is ever deleted. Removing a project dependency keeps a record too.
- Every change shows up in the project's History. These are not updates: they never mark a project Changed, never
  reset Stale and never move its "Updated" date, and the PDF's "No change." stays as it was.
- People who can see a project but not edit it see the same section, read-only.
- The "Find related" AI suggestions are no longer in the drawer (same fix as #86: they saved related projects as
  blockers). Existing dependency rows are kept as they are; review them on Admin > Dependencies (#86).

### Biweekly PDF: "Waiting on" line (1c)
- New option in Admin > Report contents: "Add a 'Waiting on' line under blocked projects". It is on by default.
- When a project is waiting on something, the PDF prints one short line under its update, for example
  "Waiting on: Sample: INU bed flow redesign" (a project it waits on, plus the note if there is one) or
  "Waiting on: Northbeam Interiors: Revised bid" (an outside blocker). Long lists are cut to one line.
- Projects that are not waiting on anything print exactly as before, and turning the option off prints
  exactly as before. Reports that are already frozen never change.
- The status and flag key page is unchanged.
- The line is filled in from the new blockers once that part lands (next steps in this PR). Until then no
  real report shows it.
