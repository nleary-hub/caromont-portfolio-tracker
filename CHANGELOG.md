# Changelog

Plain-language notes for Nick. Newest first.

## Unreleased

- Dashboard heartbeat is now one global setting (Oct 22): admins turn it on or off on Admin > Settings > Dashboard, for everyone. Off by default, including existing users after deploy. The switch is gone from the account menu. Only admins can change it (checked on the server). Sign-in is unchanged. Migration 0067 adds one settings table; nothing is dropped.
- Tracker batch (Oct 20): voice chat can make edits (read back, then applied after you say yes), the next milestone suggestion shows as light text in the add box (Tab or Enter adds it, Esc or typing dismisses it), the drawer has compact AI changes and History buttons, names can be used once without saving them to the list, name lists sort by how often each name is used, a project can be marked No contract lead, each project can label its lead as Contracts lead or Assigned project manager, the PDF hides the Updated date by default and orders rows within each department, and the PDF department bar can show "Department Manager: <name>". Migrations 0063 to 0066 only add columns and a table.
- Voice chat: a chat longer than 15 minutes under a raised session limit now saves when you press End chat (migration 0062 lets the stored length go up to 60 minutes, matching the limit an admin can set).

## Tracker AI overhaul (shipped in #87)

### Copy fixes (Writing Bot)
- Clearer wording in the writing prompts (house report style), the template basis note, the dictation hint, the
  blocker suggestions ("Suggest blockers for every project", "external blocker") and the model fallback captions; the
  playbook's "Ask:" line no longer doubles a period.

### Dictation flows straight in (item 11)
- In the command bar, what you dictate is sent as your message right away (unchanged from the command bar item).
- In Meeting notes (AI menu, AI tools, and Process meeting notes on a playbook), dictated text lands in the notes box
  with the cursor at the end, so you can keep talking or fix a word. Ctrl+Enter (Cmd+Enter on a Mac) suggests the
  updates, no reach for the button. A short line under the box says so.

### Template AI assistant uses your real checklists (item 10)
- Audit: before, Draft a template and Edit with AI used only what you typed plus the template itself, so they saved
  little work. Fixed rather than removed.
- Edit with AI now sees what the projects built from that template actually did: the steps most of them dropped or
  renamed, and the steps they kept adding by hand (counted by the tracker). Ask it to "match how we really run these"
  and it proposes those changes in the projects' own wording.
- Draft a template now sees the milestones that recur across the line's projects, so a new template starts from
  steps you already use.
- The review says what it was based on, for example "Based on the checklists of 4 projects that use this template."
  Only counts and step names are sent, no people or dates. Nothing saves until you apply, as before.

### Writing assistant knows the project (item 9)
- Draft from bullets, Fit for report and Revise with AI now get the project's facts (people, milestones, status,
  blockers) and its last 3 updates, so names, dates and terms stay the way the tracker has them.
- They write in the house report style: what happened or where it stands in the past tense, then the next action and
  who owns it, when your text says them. Draft puts the status and next action first, because the biweekly report
  shows the first 200 characters. Fit for report still keeps to 200 characters.
- The project facts are for consistency only. Nothing from them is added unless your text says it too, and the number
  and date check still compares the suggestion with your text alone. On the New project form there are no facts yet,
  so it works on your text as before.

### AI blocker suggestions live in Dependencies (item 8)
- The old "Related-project links" tool is gone for good (it saved related projects as Blocked by). Its AI settings
  toggle is back, renamed "Dependency suggestions (AI blockers)".
- In a project's Dependencies section, "Suggest blockers from updates" reads that project's Latest update and
  suggests either a Blocked-by link (it says which project waits on which) or an outside blocker (vendor, committee,
  contracts team and so on), each with the words from the update that show the wait.
- Admin, Dependencies has "Run the suggestion pass on every project": the code first picks the projects whose Latest
  update says "waiting on", "pending", "requires", "until" and the like, or names another project, and the AI checks
  only those. You get one list to review.
- Nothing is added until you apply a line. Each line goes through the same checks as adding it by hand (no cycles, no
  duplicates of an existing blocker or link), and history tags it as a dependency suggestion. A project that is only
  related is not suggested.

### Request to draft project picks the template and checks for duplicates (item 7)
- Paste a request on AI tools and the draft now comes back with the template that fits (Admin, Templates). Create
  project adds that template's milestones to the new project, with the due date on the first one, in one save.
- It fills in the department, the requester (the physician champion field) and the REQ number when the request names
  them and the name is on your lists. A field stays blank only when the request doesn't say. Owner is always left
  for you to assign.
- It checks the tracker for the same project first: the AI's pick, plus a check in code for the same REQ number or a
  shared vendor or device name (for example two "Northwind" projects). Each match has an "Update it instead" button
  that turns the request into updates for that project on the usual confirm card, and no new project is created.
- You can still change any field, the department, requester and template before you create it.

### Next-step suggestion reads the plan (item 6)
- "Recommend next milestone" (the row's ... menu, or the project drawer) now reads the project's whole milestone plan,
  the template its milestones came from, its blockers and its updates, not just the Latest update.
- It says which milestone is really next: the first open one, an earlier step still open, or a step the template has
  and the plan skipped (a new milestone). It also suggests the owner (only someone the tracker already names), a
  realistic due date (never in the past), and one concrete action for this week.
- Apply puts it in the plan the same way the drawer does: moves that milestone up to current, or adds the missing one,
  and sets its owner and date. The action for this week is shown, not saved.
- The standalone Next-step section on AI tools is gone; it points you to the row menu and the drawer instead.

### Quick capture is the command bar (item 5)
- Quick capture and the command bar are one thing now: the header button, the Q key and the Quick capture section on
  AI tools all open the same assistant. The old one-project capture box is gone from AI tools.
- One rough line can touch several projects ("Northwind supply now in the review queue, 5102 rebate still waiting on
  it"). Projects are found by name, REQ number or the vendor an outside blocker waits on, and the changes come back on
  one review card.

### Plain-English bulk edit (item 4)
- Describe one change for many projects ("Make Avery Lin the owner of every IR project with no owner"). Besides
  status, next milestone and dates, it can now set the owner, contracts lead, requester, department or the current
  milestone's owner, complete each project's current milestone, or mark projects reviewed. It never touches the Latest
  update.
- New filters: department (full or short name), owner, no owner, overdue, blocked, plus the old status, date and name
  filters.
- First you see what the AI understood, in plain words ("Open projects where no owner is assigned"), with the change
  and how many projects match. Then the same review card as everywhere else: Apply all, or line by line.
- "Bulk edit selected (N)" from the AI menu now only ever touches the rows you selected. Before, the filter could
  reach other projects too.
- A person not on the People lists is refused for every row, never added. Projects that already have the value are
  counted, not listed as changes.

### Meeting notes to updates
- Paste or dictate your notes from a meeting (AI menu > Meeting notes to updates, AI tools, or Process meeting notes
  on a saved playbook). Dictated text lands in the notes box as you speak, no paste needed.
- Each note is matched to its project by name, REQ number (a note that only says "5123" still finds the project),
  vendor or owner. One paragraph can cover many projects.
- It handles more than the Latest update: status, owner and other people, completing or adding milestones, a
  milestone's owner or due date, and outside blockers. "Drywall is done" completes the Drywall milestone.
- Several notes about the same project become one line, with one Latest update written in the same voice and length
  as that project's earlier updates (what happened, then the next step and who owns it). No facts that aren't in your
  notes.
- Everything shows on one review card with Apply all, or apply and reject line by line. History tags each saved change
  "Meeting notes (AI), applied by ..." and marks the project Changed like a manual edit.
- A new project mentioned in the notes comes back as a draft to review and create. Notes it could not match to any
  project are listed, so nothing said in the meeting gets lost. A person not on the People lists is never added; that
  line is listed under "Not suggested" with the reason.
- From a playbook, the planned follow-ups go along with your notes, and the ones the notes agree to become milestone or
  update suggestions.

### Meeting Playbook (replaces the pre-meeting brief)
- New full-width Meeting Playbook page. Pick the meeting (Biweekly review with your senior director, department or
  manager huddle, governance or SIVAT prep, contracts or vendor sync, 1:1 with a manager), what it covers (the whole
  line, a department, an owner, or the rows you selected or filtered on the dashboard), 15, 30 or 60 minutes, and an
  optional focus.
- Eight sections: bottom line; decisions and escalations (who decides, your ask, what happens if it slips); a timed
  agenda that fits the length; talking points per project (what changed since the last report, the real blocker, the
  owner, the question and who to ask, the next step with a date); the watchlist; dependencies and patterns (what each
  blocker project holds up, and outside blockers grouped by who they wait on); wins; and a follow-up tracker.
- The watchlist and blocker lists are computed by the tracker, the same as the dashboard. Every project name links to
  the project. A person the tracker doesn't name shows as "No owner assigned"; dates in the past are dropped.
- Each playbook is saved with its time, meeting type and scope so you can reopen it. Copy, Print or PDF (your
  browser's print, not the biweekly report), Export to Word, or email-ready text.
- "Process meeting notes" on a saved playbook sends your notes through Meeting notes to updates with the playbook's
  follow-ups as context. Nothing changes until you apply it.
- The brief card above the dashboard table is gone. Open the playbook from the AI menu (for selected or filtered rows),
  the Playbook button in a project's drawer, or AI tools.

### Type it or say it (voice chat and the command bar)
- Quick capture (the button, or press Q) now opens the command bar: the same assistant as voice chat, in a text box,
  for when talking out loud isn't possible. Ask questions ("Who owns the EEG upgrade?") or type changes in plain words.
- One line can touch several projects ("REQ 4417 supply now in the review queue, EEG upgrade off track"). Projects are
  matched by name, REQ number, vendor, department or owner.
- Changes show as the same review card as voice chat. Nothing changes until you click Apply (all or per line) or type
  yes. "Undo that" undoes the last apply. A new project request comes back as a draft to review and create.
- Dictation in the command bar sends what you said straight away, no extra click.
- Voice chat shows a running transcript (on screen only, never saved) next to the change cards.
- The voice chat time limit is now a setting (Admin > AI settings, Voice chat row, 1 to 60 minutes, default 15), and
  a "One minute left" warning shows before the chat ends.

### The right model for each job, and what each run costs (D: model routing and usage)
- Each AI feature now starts on the model you approved, shown on its row in Admin > AI settings > Features as
  "Recommended default". You can change any of them there, like any other pick:
  - gpt-6.1-sol: Pre-meeting brief (becoming the Meeting Playbook), Meeting notes to updates, Quick capture (the
    command bar, and the step behind voice chat that turns what you say into changes), Request to draft project.
  - gpt-6-luna: Fit for report, Revise with AI and Draft from bullets (short rewrites).
  - Unchanged: Voice chat keeps its live model and Dictation its transcription model. Bulk edit, Next step and
    Template AI keep using the model chosen in AI settings.
- A model you already picked for a feature is never replaced. Your list of models under Models is not touched: no
  model is turned on and no key is added.
- If a default's model is not on under Models (or there is no OpenAI key), that feature keeps working on the model
  chosen in AI settings, and its row says so in amber ("Off under Models; using ... for now").
- New "Usage" card on AI settings (last 30 days): for each feature, how many runs, lines proposed, applied and
  rejected, the apply rate, tokens, average response time and estimated cost. Below it, the newest runs with the
  model, tokens, response time and estimated cost of each. Costs are estimates from the prices under Models.
- Dictation cleanup has no separate AI step today (dictation is transcription only), so there is nothing to route yet.

### Say yes before anything changes (C: confirmation)
- Voice chat can now make the change for you. It proposes the change, reads it back in one sentence ("Status to Off
  track on Cortex EEG Upgrade; ... Apply?"), and applies it only after you clearly say yes. It says a change was
  applied only after the save worked; if a line could not be applied it tells you why.
- Say "undo that" to undo the last apply.
- Every review card now has Apply all next to the per-line Apply and Reject (and Edit on the text tools). Voice chat
  shows the same card, so you can also apply or reject by clicking.
- After an apply or undo the dashboard refreshes by itself, so the change shows right away.

### One set of AI actions, checked like a manual edit (B: shared action layer)
- Behind the scenes, every AI feature that changes projects now uses the same actions: find a project (by name, REQ
  number, vendor, department or owner), read one project in full, propose changes, apply them after you say yes, undo
  the last apply, draft a new project, and record a real Blocked-by.
- The AI can now propose much more than the old five fields: owner, requester, contracts lead, department, a
  milestone's owner or due date, completing, adding, moving or removing a milestone, Mark as reviewed, and adding,
  changing or resolving blockers and Blocked-by links.
- Every value is checked on the server against the line's lists before you see it. A person who is not on the People
  lists, a department that is not in the line, or a date that does not exist is refused with a plain reason; the AI
  never adds a new name.
- Applied changes go through the same saves as the drawer, so they are validated, permission-checked, written to
  History and mark the project Changed exactly like a manual edit. History says where they came from, for example
  "Voice chat (AI), applied by Nick Leary".
- Undo puts back the last apply (within a day). Anything that was changed again since is left alone and named.
- "Related projects" are never saved as Blocked by: a link is saved only as a real dependency, with what it waits on.
- Voice chat, the command bar and the review panels start using these actions in the next steps (C onward).

### Every AI feature now sees the whole picture (A: shared context)
- One context builder feeds every AI tool (meeting notes, bulk edit, quick capture, next step, request to draft, the
  pre-meeting brief) and voice chat. Each project now comes with its REQ number, department, description, MFI and
  in-report flags, owner, requester, contracts lead, the current milestone's owner, every milestone in order (name,
  owner, due date, done) with "N of M", the full Latest update (no more 300-character cut) and up to 3 earlier
  updates with dates, what changed since the last report, the last reviewed date, its blockers both ways, and how
  long it has been blocked.
- Facts are worked out by the app, not guessed by the AI: overdue, due within 14 days, stale, days in the current
  status, "No change" for 2+ reports in a row, Off track or At risk for 2+ reports in a row, no owner, current
  milestone with no owner, "on track but past due", plus the five blocker flags. Overdue and Stale use the exact same
  rules as the dashboard and the PDF.
- Every prompt also gets today's date, the service line, your name and role title, and the org glossary.
- New card on Admin > AI settings: "Context". Set your role title and edit the glossary (term plus definition). It
  starts with SIVAT, VIPER, HPG, Infor, MFI, PAR, New Services team, Invasive Governance and EP Governance, with the
  definitions left blank for you to write. Terms are never deleted, and every change is logged.
- The context covers a full service line (up to 500 projects) and stays inside a size budget: when it is too big,
  the oldest earlier updates go first, then long descriptions, then finished milestones, then closed projects with no
  blockers, then long updates.

### Polish from the provider keys review (Figma Bro)
- Admin > AI settings > Provider keys: while a key is rotating, the Rotate button is greyed exactly like Test and
  Replace (it no longer lights up under the mouse).
- The "No key" and "Key failing" notes in the provider picker are no longer underlined (they are not links).

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
