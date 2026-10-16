# Drawer field audit: pre-#73 edit drawer vs current (fix/assign-people, #81)

Baseline: `2245d4c^1` (main just before #73). Current: `4e32074` (#81). Compared: `ProjectEditForm.tsx`, plus the drawer and read-only details in `ProjectDashboard.tsx`.
I diffed field ids (`pf-*`), labels, sections, sub-components and buttons/test ids.

| Field / control | Pre-#73 | Now | Status | Evidence |
|---|---|---|---|---|
| Name (`pf-name`) | yes | yes | present | — |
| Department (`pf-serviceArea`) | yes | yes | present | — |
| Status (`pf-status`, read-only status note) | yes | yes | present | — |
| Start date (`pf-startDate`) | input | DueDatePopover | present (restyled) | #76 191bd5b "own Start date field" |
| Completed on (`pf-completedOn`, automatic-date helper) | yes | yes | present | — |
| Infor number (`pf-inforRequestNumber`) + "Previously" line | yes | yes | present | — |
| Milestones editor (autosave) | yes | yes | present | — |
| % complete (`pf-percentComplete`) | yes | no | intentionally dropped | #73 04f2719 "…hide % complete"; form comment "the stored value is kept and never sent" |
| Latest update / note (`pf-note`), Accomplishment, Description | yes | yes | present | — |
| AI review panel | yes | yes | present | — |
| People section: Owner, Requester, Contracts lead (`inForm` ProjectPeopleEditor, saves on each pick) | yes, after Notes; top of the view drawer pre-#73 | yes, top of the form | restored (moved to top) | #73 2245d4c made one-click open the form, so the top-of-panel people editor went away; restored by #81 4e32074 |
| Contracts lead options from the line's list | not passed in the form (only "To assign" + current) | passed | restored (bug fix) | #81 4e32074 (`contractsLeads={line.contractsLeads}`) |
| Department select in the people editor | view drawer only | not in form (form has `pf-serviceArea`) | present (one Department control) | `inForm` hides the duplicate on purpose (ProjectPeopleEditor) |
| MFI checkbox | n/a (added in #77) | yes, top of the form | present (moved) | #77 aed54c0; moved by #81 |
| Admin: Hide from report, Delete project | view drawer bottom | form Admin section | present (moved) | #73 71fbd58 "Hide from report in the form's Admin section above Delete" |
| History section | view drawer | in the form drawer | present | #73 04f2719 "History and admin controls in the edit drawer" |
| Save / Cancel footer + Discard changes? (edit) | yes | auto-save status footer; Cancel this project? dialog | intentionally replaced | #74 1fc41dd "debounced save, Saving/Saved/Error, flush on close"; ae20f04 |
| Save / Cancel footer (New project) | yes | yes | present | — |
| Edit button (view to edit) | yes | no | intentionally dropped | #73 04f2719 "one-click open" |
| Read-only note counter (`drawer-note-counter`) | yes | no | intentionally dropped | #74 ae20f04 "plain read-only note" |
| Dependencies editor, AI related links, AI next step, header Brief, Blocked-by tag | yes | yes | present | — |

Result: nothing else was dropped unintentionally. The only unintended losses were the people pickers (pushed out of view) and the empty contracts-lead list, and #81 restores both.

## Non-admin drawer
`ProjectDashboard.tsx` gates both editors on `admin`: `peopleEditor={admin ? <ProjectPeopleEditor…/> : null}`, and `form` only renders when `admin && admin.formValues[id]`. A non-admin gets `ReadOnlyDetails` (`data-testid="drawer-readonly"`), which shows Department, Owner, Requester and Contracts lead as plain text ("To assign" when blank) with no pickers. A non-admin also sees no edit form at all (no Name input, no MFI checkbox). `admin` comes from `viewer.isAdmin` = `AdminPolicy.fromEnv(env).allows(email)` (src/lib/auth/SessionAccess.ts), which is an env allow-list.
