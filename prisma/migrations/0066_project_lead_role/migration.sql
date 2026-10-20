-- 0066_project_lead_role: per project, the contract lead role label can read "Assigned project manager".
--
-- Why: some projects have an assigned project manager instead of a contract lead. The label defaults to the
-- contract lead and is switched per project from a tucked-away control in the project drawer. Changes are
-- recorded in the project history like any other field.
--
-- Add-only. One TEXT column on "Project", NOT NULL with DEFAULT 'contractLead' (every existing project keeps
-- its label), and a CHECK limiting it to the two roles. No data changes, no other column, constraint, index,
-- trigger or function changes. Idempotent: ADD COLUMN IF NOT EXISTS; the CHECK is added only once.
-- Rollback (safe): ALTER TABLE "Project" DROP COLUMN "leadRole";

ALTER TABLE "Project" ADD COLUMN IF NOT EXISTS "leadRole" TEXT NOT NULL DEFAULT 'contractLead';
ALTER TABLE "Project" ADD CONSTRAINT "Project_lead_role" CHECK ("leadRole" IN ('contractLead', 'projectManager'));
