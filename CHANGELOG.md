# Changelog

Plain-language notes for Nick. Newest first.

## Unreleased: Tracker AI overhaul (draft PR, stacked on the per-feature AI provider PR)

### Dashboard: who is blocked, at a glance (1b)
- A project waiting on something gets an amber tag after its name, for example
  "Waiting on Northbeam Interiors · 12 days": the most recent thing it waits on and how long it has been blocked
  (since its oldest open blocker). Long tags are cut short; hover to see every open item.
- A project other projects wait on gets a grey "Blocking 2" tag. Clicking either tag opens the project at
  "Dependencies & blockers".
- New "Blocked" filter in the filter bar (with a count), and a new "Blocked" tile with a count and, when any are
  late, "3 follow-ups overdue". Click the tile to filter too. Hide it like any tile. The PDF's counts never include it.
- Warning flags, words only (they never change a status): a small amber ⚑ on the tag, listing in plain words
  "Due Nov 4, before its blocker (due Nov 18)", "On track, but its blocker is Off track" (or On hold),
  "Follow-up overdue since Oct 15", "Blocker was Cancelled" or "Blocked for 30+ days". The drawer shows the same
  flags in an amber line at the top of the section.
- When a project it waits on is Complete, the drawer asks "Imaging Scheduler Upgrade is Complete. Clear it?" and the
  tag shows a small ↻. Clear removes the dependency (kept in History as cleared). Dismiss hides the question for you
  only; it comes back if the dependency is ever added again.

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
- The line lists every open "Blocked by" project (by name, plus its note) and every open outside blocker from the
  drawer's "Dependencies & blockers". Removed and resolved ones never print. There is no date cut-off.
