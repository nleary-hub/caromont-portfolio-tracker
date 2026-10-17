# Changelog

Plain-language notes for Nick. Newest first.

## Unreleased: Tracker AI overhaul (draft PR, stacked on the per-feature AI provider PR)

### Biweekly PDF: "Waiting on" line (1c)
- New option in Admin > Report contents: "Add a 'Waiting on' line under blocked projects". It is on by default.
- When a project is waiting on something, the PDF prints one short line under its update, for example
  "Waiting on: Northbeam Interiors revised bid · 12 days". Long lists are cut to one line.
- Projects that are not waiting on anything print exactly as before, and turning the option off prints
  exactly as before. Reports that are already frozen never change.
- The status and flag key page is unchanged.
- The line is filled in from the new blockers once that part lands (next steps in this PR). Until then no
  real report shows it.
