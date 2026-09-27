-- Production-shaped data at migration 0015 (before service lines), for the 0016 migration test and the local
-- end-to-end check. Deterministic: fixed ids and timestamps. Mirrors the live shape: projects in all seven
-- departments plus unassigned, archived (deleted) and hidden projects, full history, milestone checklists
-- (some from templates), the six seeded templates plus an admin-made one with audit rows, two frozen reports
-- with artifacts and deliveries, report options with history, view settings with history, recipients, and a
-- service line settings row that was edited (with history).

-- Projects: 42 across Cath, EP, Echo, CVSS, INU, CardioNeuro, IR, 3 unassigned.
INSERT INTO "Project" (id, name, "serviceArea", owner, "physicianChampion", status, "nextMilestone", "dueDate", note,
  "includeInReport", "createdAt", "updatedAt", "updatedBy", "archivedAt", "deletedBy", "hiddenFromDashboard", "hiddenFromReport",
  description, infor_request_number, accomplishment, "completedOn", "requesterNotApplicable", "contractsLead")
SELECT
  ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'Project ' || lpad(i::text, 2, '0') || CASE WHEN i % 5 = 0 THEN ' with a longer name for wrapping in the report' ELSE '' END,
  (CASE WHEN i > 39 THEN NULL ELSE (ARRAY['Cath','EP','Echo','CVSS','INU','CardioNeuro','IR'])[1 + (i % 7)] END)::"ServiceArea",
  (ARRAY['Dr. Patel','Kim Nguyen','Luis Ortega','To assign',NULL])[1 + (i % 5)],
  CASE WHEN i % 4 = 0 THEN NULL ELSE 'Dr. Requester ' || (i % 6) END,
  (ARRAY['OnTrack','AtRisk','OffTrack','OnHold','NotStarted','Complete','OnTrack'])[1 + (i % 7)]::"ProjectStatus",
  CASE WHEN (i % 7) IN (3, 4, 5) THEN NULL ELSE 'Milestone ' || i END,
  CASE WHEN i % 3 = 0 THEN NULL ELSE DATE '2026-09-01' + (i * 3) END,
  CASE WHEN i % 6 = 0 THEN 'Note for project ' || i ELSE NULL END,
  true,
  TIMESTAMP '2026-06-01 12:00:00' + (i || ' hours')::interval,
  TIMESTAMP '2026-09-10 12:00:00' + (i || ' hours')::interval,
  'nick@example.org',
  CASE WHEN i IN (7, 21) THEN TIMESTAMP '2026-09-12 15:00:00' ELSE NULL END,
  CASE WHEN i IN (7, 21) THEN 'nick@example.org' ELSE NULL END,
  i = 11,
  i IN (11, 12),
  CASE WHEN i % 2 = 0 THEN 'Description ' || i ELSE NULL END,
  CASE WHEN i % 4 = 1 THEN 10000 + i ELSE NULL END,
  CASE WHEN (i % 7) = 5 THEN 'Went live ' || i ELSE NULL END,
  CASE WHEN (i % 7) = 5 THEN DATE '2026-09-15' + (i % 5) ELSE NULL END,
  i % 4 = 0,
  (ARRAY['Shea Waldron','Jeff Krause','Mellisa Gonzales','Dave Dermady','Amber Hatley',NULL])[1 + (i % 6)]
FROM generate_series(1, 42) AS i;

-- History: created row per project, status and field changes, admin-only visibility and delete rows.
INSERT INTO "ProjectHistory" (id, "projectId", field, "oldValue", "newValue", "changedAt", "changedBy", comment)
SELECT ('20000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'created', NULL, 'Project ' || i, TIMESTAMP '2026-06-01 12:00:00' + (i || ' hours')::interval, 'nick@example.org', 'CSV import'
FROM generate_series(1, 42) AS i;
INSERT INTO "ProjectHistory" (id, "projectId", field, "oldValue", "newValue", "changedAt", "changedBy")
SELECT ('21000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ('10000000-0000-4000-8000-' || lpad((1 + (i % 42))::text, 12, '0'))::uuid,
  (ARRAY['status','nextMilestone','note','owner','dueDate'])[1 + (i % 5)], 'old ' || i, 'new ' || i,
  TIMESTAMP '2026-09-02 09:00:00' + (i * 37 || ' minutes')::interval, 'editor@example.org'
FROM generate_series(1, 300) AS i;
INSERT INTO "ProjectHistory" (id, "projectId", field, "oldValue", "newValue", "changedAt", "changedBy") VALUES
  ('22000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'hiddenFromDashboard', 'false', 'true', '2026-09-11 10:00:00', 'nick@example.org'),
  ('22000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000011', 'hiddenFromReport', 'false', 'true', '2026-09-11 10:00:00', 'nick@example.org'),
  ('22000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000012', 'hiddenFromReport', 'false', 'true', '2026-09-11 10:05:00', 'nick@example.org'),
  ('22000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000007', 'archivedAt', NULL, '2026-09-12T15:00:00.000Z', '2026-09-12 15:00:00', 'nick@example.org'),
  ('22000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000021', 'archivedAt', NULL, '2026-09-12T15:00:00.000Z', '2026-09-12 15:00:00', 'nick@example.org');

-- One admin-made template (the six seeded ones come from 0015) with items and audit rows.
INSERT INTO milestone_templates (id, name, position, "createdAt", "updatedAt", "updatedBy")
VALUES ('30000000-0000-4000-8000-000000000001', 'EP lab refresh', 7, '2026-09-05 10:00:00', '2026-09-05 10:00:00', 'nick@example.org');
INSERT INTO milestone_template_items (id, "templateId", name, position)
SELECT ('31000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, '30000000-0000-4000-8000-000000000001', 'EP step ' || i, i FROM generate_series(1, 5) AS i;
INSERT INTO milestone_template_history (id, "templateId", action, "oldValue", "newValue", "changedAt", "changedBy") VALUES
  ('32000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', 'template_created', NULL, '{"name":"EP lab refresh"}', '2026-09-05 10:00:00', 'nick@example.org'),
  ('32000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000001', 'item_added', NULL, '{"name":"EP step 1"}', '2026-09-05 10:01:00', 'nick@example.org'),
  ('32000000-0000-4000-8000-000000000003', NULL, 'template_deleted', '{"name":"Scratch"}', NULL, '2026-09-05 10:02:00', 'nick@example.org');

-- Checklists: projects 1-30 get 1 to 4 steps; some from the admin template, some done.
INSERT INTO project_milestones (id, "projectId", name, "dueDate", done, "doneAt", position, "sourceTemplateId", "createdAt", "updatedAt")
SELECT ('40000000-0000-4000-8000-' || lpad((p * 10 + s)::text, 12, '0'))::uuid,
  ('10000000-0000-4000-8000-' || lpad(p::text, 12, '0'))::uuid,
  'Step ' || s || ' of project ' || p,
  CASE WHEN s % 2 = 0 THEN DATE '2026-10-01' + p ELSE NULL END,
  s = 1 AND p % 3 = 0,
  CASE WHEN s = 1 AND p % 3 = 0 THEN DATE '2026-09-20' ELSE NULL END,
  s,
  CASE WHEN p % 5 = 0 THEN '30000000-0000-4000-8000-000000000001'::uuid ELSE NULL END,
  '2026-09-06 09:00:00', '2026-09-06 09:00:00'
FROM generate_series(1, 30) AS p, generate_series(1, 4) AS s
WHERE s <= 1 + (p % 4);

-- Report settings: options row (key page off) with history carrying departments and totals grid.
INSERT INTO report_options (id, "showKeyPage", "updatedAt", "updatedBy") VALUES ('report', false, '2026-09-14 11:00:00', 'nick@example.org')
ON CONFLICT (id) DO UPDATE SET "showKeyPage" = EXCLUDED."showKeyPage", "updatedAt" = EXCLUDED."updatedAt", "updatedBy" = EXCLUDED."updatedBy";
INSERT INTO report_options_history (id, "oldValue", "newValue", "changedAt", "changedBy") VALUES
  ('50000000-0000-4000-8000-000000000001', '{"showKeyPage":true}', '{"showKeyPage":false}', '2026-09-08 11:00:00', 'nick@example.org'),
  ('50000000-0000-4000-8000-000000000002', '{"showKeyPage":false}', '{"showKeyPage":false,"departments":["Cath","EP","CardioNeuro"],"totalsGrid":"lastPage"}', '2026-09-14 11:00:00', 'nick@example.org');

-- View settings (both contexts) with history.
INSERT INTO view_settings (context, "columnOrder", "hiddenColumns", "hiddenStatuses", "updatedAt", "updatedBy") VALUES
  ('dashboard', NULL, ARRAY['inforNumber'], ARRAY['Cancelled']::"ProjectStatus"[], '2026-09-09 10:00:00', 'nick@example.org'),
  ('report', NULL, ARRAY[]::text[], ARRAY['Cancelled','NotStarted']::"ProjectStatus"[], '2026-09-09 10:00:00', 'nick@example.org')
ON CONFLICT (context) DO UPDATE SET "hiddenColumns" = EXCLUDED."hiddenColumns", "hiddenStatuses" = EXCLUDED."hiddenStatuses", "updatedAt" = EXCLUDED."updatedAt", "updatedBy" = EXCLUDED."updatedBy";
INSERT INTO view_settings_history (id, context, "oldValue", "newValue", "changedAt", "changedBy") VALUES
  ('60000000-0000-4000-8000-000000000001', 'report', '{"hiddenStatuses":["Cancelled"]}', '{"hiddenStatuses":["Cancelled","NotStarted"]}', '2026-09-09 10:00:00', 'nick@example.org');

-- Recipients.
INSERT INTO "Recipient" (id, name, email, role, "serviceArea", line, active) VALUES
  ('70000000-0000-4000-8000-000000000001', 'Frank Director', 'frank@example.org', 'Director', NULL, 'To', true),
  ('70000000-0000-4000-8000-000000000002', 'Cath Lead', 'cath@example.org', 'Lead', 'Cath', 'Cc', true),
  ('70000000-0000-4000-8000-000000000003', 'Former Lead', 'former@example.org', NULL, 'EP', 'Cc', false);

-- Service line settings: edited once and edited back (history keeps both), current value is the seed.
INSERT INTO service_line_settings_history (id, "oldValue", "newValue", "changedAt", "changedBy") VALUES
  ('80000000-0000-4000-8000-000000000001', '{"name":"Cardiovascular & Pulmonary Service Line","shortName":"CVPSL"}', '{"name":"Heart and Lung Service Line","shortName":"HLSL"}', '2026-09-03 10:00:00', 'nick@example.org'),
  ('80000000-0000-4000-8000-000000000002', '{"name":"Heart and Lung Service Line","shortName":"HLSL"}', '{"name":"Cardiovascular & Pulmonary Service Line","shortName":"CVPSL"}', '2026-09-03 10:05:00', 'nick@example.org');
UPDATE service_line_settings SET "updatedAt" = '2026-09-03 10:05:00', "updatedBy" = 'nick@example.org' WHERE id = 'service_line';

-- Two frozen reports with artifacts and deliveries (one Drive, one signed link fallback).
INSERT INTO "ReportSnapshot" (id, "periodStart", "periodEnd", "generatedAt", "generatedBy", "rowsJson", "missingChampionsJson", "headerJson",
  "viewSettingsJson", "optionsJson", "completedJson", "serviceLineJson", "pdfStorageKey", "sentAt", "sentToJson", "deliveryJson") VALUES
  ('90000000-0000-4000-8000-000000000001', '2026-08-26', '2026-09-09', '2026-09-09 21:00:00', 'cron', '[{"id":"10000000-0000-4000-8000-000000000001","name":"Project 01"}]',
   '[]', '{"total":1}', '{"hiddenStatuses":["Cancelled"]}', '{"showKeyPage":true}', '[]', '{"name":"Cardiovascular & Pulmonary Service Line","shortName":"CVPSL"}',
   'db:90000000-0000-4000-8000-000000000001/pdf', '2026-09-09 21:01:00', '["frank@example.org"]', '{"status":"drive"}'),
  ('90000000-0000-4000-8000-000000000002', '2026-09-09', '2026-09-23', '2026-09-23 21:00:00', 'cron', '[{"id":"10000000-0000-4000-8000-000000000002","name":"Project 02"}]',
   '[]', '{"total":1}', '{"hiddenStatuses":["Cancelled","NotStarted"]}', '{"showKeyPage":false,"departments":["Cath","EP","CardioNeuro"],"totalsGrid":"lastPage"}', '[]',
   '{"name":"Cardiovascular & Pulmonary Service Line","shortName":"CVPSL"}', NULL, NULL, NULL, '{"status":"signed_link"}');
INSERT INTO report_artifacts (id, "snapshotId", kind, "fileName", "contentType", bytes, "byteSize", sha256, "createdAt") VALUES
  ('91000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 'pdf', 'cardiac-portfolio-report-2026-09-09.pdf', 'application/pdf', '\x255044462d312e340a', 9, 'aa', '2026-09-09 21:00:30'),
  ('91000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001', 'handoff', 'handoff.json', 'application/json', '\x7b7d', 2, 'bb', '2026-09-09 21:00:30'),
  ('91000000-0000-4000-8000-000000000003', '90000000-0000-4000-8000-000000000002', 'pdf', 'cardiac-portfolio-report-2026-09-23.pdf', 'application/pdf', '\x255044462d312e340a', 9, 'cc', '2026-09-23 21:00:30');
INSERT INTO report_deliveries (id, "snapshotId", "attemptedAt", method, status, "detailJson", "triggeredBy") VALUES
  ('92000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', '2026-09-09 21:01:00', 'drive', 'drive', '{"fileId":"abc"}', 'cron'),
  ('92000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002', '2026-09-23 21:01:00', 'drive', 'signed_link', '{"driveError":"quota"}', 'cron');
