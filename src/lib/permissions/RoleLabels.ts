import type { HIDDEN_KEYS, PermissionGroup, PermissionKey } from "@/lib/permissions/PermissionKeys";

/**
 * Roles editor copy (labels revision d, 2026-10-22-d-rbac-permission-labels.md). One label and helper per visible key:
 * the 57 grantable keys plus admin.ai.keys ("Owner only."). The 6 hidden Owner-only keys have no label on purpose,
 * so nothing a non-owner can reach ever names them.
 */
export type VisibleKey = Exclude<PermissionKey, (typeof HIDDEN_KEYS)[number]>;

export const KEY_LABELS: Record<VisibleKey, { label: string; helper: string }> = {
  "project.view": { label: "View projects", helper: "See projects in the service lines and departments you've been granted." },
  "project.create": { label: "Create projects", helper: "Add new projects with the form or by importing new rows." },
  "project.edit": { label: "Edit projects", helper: "Change project fields, milestones and update notes." },
  "project.review": { label: "Mark projects reviewed", helper: "Mark projects as reviewed, or undo that mark." },
  "project.hide": { label: "Hide projects", helper: "Hide or unhide projects on the dashboard and report." },
  "project.delete": { label: "Delete projects", helper: "Delete projects. Deleted projects can be restored." },
  "project.restoreDeleted": { label: "Restore deleted projects", helper: "Bring back projects that were deleted." },
  "project.dependencies.edit": { label: "Edit dependencies", helper: "Add, change and remove project dependencies and blockers." },
  "project.history.full": { label: "View full history", helper: "See every history entry, including admin-only entries." },
  "status.change": { label: "Change project status", helper: "Change a project's status. Complete is still set by the last milestone." },
  "lifecycle.reopenCancelled": { label: "Reopen cancelled projects", helper: "Move cancelled projects back to active." },
  "lifecycle.reopenCompleted": { label: "Reopen completed projects", helper: "Unchecks the final milestone." },
  "people.view": { label: "View people", helper: "Open the People page and see people on lines you hold." },
  "people.user.add": { label: "Add users", helper: "Add new users to lines you hold." },
  "people.access.grant": { label: "Manage line access", helper: "Give or remove access to lines and departments you hold yourself." },
  "people.user.password": { label: "Reset passwords", helper: "Reset passwords and unlock accounts for users ranked below you." },
  "people.user.signIn": { label: "Turn sign-in on or off", helper: "Turn sign-in on or off for users ranked below you." },
  "people.role.assign": { label: "Assign roles", helper: "Give users a role ranked below your own." },
  "people.list.add": { label: "Add list names", helper: "Add names to the owner, requester and contracts-lead lists." },
  "people.list.manage": { label: "Manage list names", helper: "Rename or remove names on the owner, requester and contracts-lead lists." },
  "dashboard.item.heartbeat": { label: "View heartbeat", helper: "Show the heartbeat line and tile shading on the dashboard." },
  "dashboard.item.statusChips": { label: "View status chips", helper: "Show the Changed, Overdue and Stale chips." },
  "dashboard.item.columns.sensitive": { label: "View sensitive columns", helper: "Show the columns marked as sensitive." },
  "dashboard.item.blockers": { label: "View blockers", helper: "Show blocker pills on projects." },
  "dashboard.item.history": { label: "View History tab", helper: "Show the History tab on projects." },
  "dashboard.item.aiControls": { label: "Show AI buttons", helper: "Show AI buttons on the dashboard." },
  "report.view": { label: "View reports", helper: "Open the Reports page." },
  "report.pdf.onDemand": { label: "Generate PDFs on demand", helper: "Use \"Generate PDF now\" to download a current PDF." },
  "pdf.item.sections": { label: "View PDF sections", helper: "Include the chosen sections in on-demand PDFs." },
  "report.yearEnd.onDemand": { label: "Generate year-end report", helper: "Create a year-end report on demand." },
  "ai.playbook": { label: "Use meeting playbook", helper: "Create a meeting playbook with AI." },
  "ai.notesToUpdates": { label: "Turn notes into updates", helper: "Turn meeting notes into project updates with AI." },
  "ai.commandBar": { label: "Use AI command bar", helper: "Use the AI command bar, which can propose edits across projects." },
  "ai.dictation": { label: "Use dictation", helper: "Dictate text with the microphone." },
  "ai.voiceChat": { label: "Use voice chat", helper: "Talk with the AI assistant by voice." },
  "ai.requestToDraft": { label: "Turn requests into projects", helper: "Turn a request into a draft project or update with AI." },
  "ai.fitForReport": { label: "Fit text for report", helper: "Shorten notes with AI so they fit the report." },
  "ai.draftFromBullets": { label: "Draft from bullets", helper: "Write a note from bullet points with AI." },
  "ai.rewrite": { label: "Revise notes", helper: "Revise an existing note with AI." },
  "ai.nextStep": { label: "Suggest next steps", helper: "Get AI suggestions for a project's next step." },
  "ai.dependencySuggest": { label: "Suggest blockers", helper: "Get AI suggestions for project blockers." },
  "ai.relatedLinks": { label: "Suggest dependencies", helper: "Get AI suggestions for related projects and dependencies." },
  "ai.bulkEdit": { label: "Bulk edit with AI", helper: "Propose edits to many projects at once with AI." },
  "ai.quickCapture": { label: "Use quick capture", helper: "Capture quick notes and let AI turn them into project changes." },
  "ai.meetingBrief": { label: "Create meeting briefs", helper: "Create a meeting brief with AI." },
  "ai.templateAi": { label: "Use AI for templates", helper: "Draft milestone templates with AI. Also needs template access." },
  "admin.settings": { label: "Manage app settings", helper: "Change admin settings, including the default dashboard heartbeat." },
  "admin.layout": { label: "Manage default layout", helper: "Set default column order, row order and view settings. Directors: own lines." },
  "admin.ai": { label: "Manage AI settings", helper: "Change AI models, prices, glossary, voice limit and feature switches." },
  "admin.ai.keys": { label: "Manage AI provider keys", helper: "Owner only." },
  "admin.ai.usage": { label: "View AI usage", helper: "See AI usage and cost. Only the owner can change limits." },
  "admin.serviceLines": { label: "Manage service lines", helper: "Add, edit, archive, delete and restore service lines." },
  "admin.departments": { label: "Manage departments", helper: "Add, edit, reorder, archive, delete and restore departments." },
  "admin.templates": { label: "Manage templates", helper: "Create and edit milestone templates." },
  "admin.import": { label: "Import projects", helper: "Import projects with CSV files." },
  "admin.export": { label: "Export to CSV", helper: "Download project data as a CSV file." },
  "admin.audit": { label: "View audit log", helper: "See the audit log. Directors see their own lines only." },
  "admin.roles": { label: "Manage roles", helper: "Create and edit roles below your own rank. The system Admin role is locked." },
};

export const GROUP_LABELS: Record<PermissionGroup, { name: string; helper: string }> = {
  projects: { name: "Projects", helper: "Work with projects on the lines you can see." },
  lifecycle: { name: "Status", helper: "Change project status and reopen cancelled or completed projects." },
  people: { name: "People and access", helper: "Manage users, their access, roles and name lists." },
  dashboard: { name: "Dashboard items", helper: "Choose which dashboard items this person sees." },
  reportView: { name: "Reports", helper: "Open the Reports page and download current and year-end PDFs." },
  ai: { name: "AI features", helper: "Use AI tools, when AI is also turned on in settings." },
  admin: { name: "Admin", helper: "Change app-wide settings and setup screens." },
};

/** The editor's three columns, top to bottom (mockup roles-f). */
export const EDITOR_COLUMNS: readonly (readonly PermissionGroup[])[] = [
  ["projects", "lifecycle", "reportView"],
  ["people", "admin"],
  ["ai", "dashboard"],
];

/** One-line descriptions of the seeded system roles (custom roles store their own). */
export const SYSTEM_ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: "All keys but owner-only",
  director: "Leads a service line",
  manager: "Runs department projects",
  editor: "Edits projects and updates",
  viewer: "Read-only dashboards",
};
