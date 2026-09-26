-- Project.contractsLead: optional Contracts lead, one of AppConfig.CONTRACTS_LEADS (validated in
-- ProjectValidator; no CHECK constraint so the list can change without a migration). Null = "To assign".
-- Additive only (nullable column, no default, no backfill).

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "contractsLead" TEXT;
