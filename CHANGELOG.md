# Changelog

Plain-language notes for Nick. Newest first.

## Unreleased: Tracker AI overhaul (draft PR, stacked on the per-feature AI provider PR)

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
