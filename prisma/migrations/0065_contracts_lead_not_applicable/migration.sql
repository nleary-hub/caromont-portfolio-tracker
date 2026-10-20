-- 0065_contracts_lead_not_applicable: an optional "No contract lead" on a project, like the requester's Not applicable.
--
-- Why: some projects have no contract lead. Marked, the contract lead line is left out of the dashboard and the
-- PDF report instead of reading "To assign".
--
-- Add-only. One BOOLEAN column on "Project", NOT NULL with DEFAULT false, so every existing project keeps its
-- current behavior. No data changes, no other column, constraint, index, trigger or function changes.
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- Rollback (safe): ALTER TABLE "Project" DROP COLUMN "contractsLeadNotApplicable";

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "contractsLeadNotApplicable" BOOLEAN NOT NULL DEFAULT false;
