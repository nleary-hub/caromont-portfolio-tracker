-- 0027_report_colors: weekly PDF colors per service line (Admin > Report contents > Report colors).
--
-- Additive: two defaulted columns on "report_options"; no other table, column or row changes.
-- - "barColor": department bar color. A preset key (navy, deeper-plum, plum) or a custom '#RRGGBB'. Default navy.
-- - "headerBand": band behind the page 1 title. 'none' (default), a preset key or a custom '#RRGGBB'.
-- The app checks contrast (WCAG AA) before saving a custom color; the CHECK constraints only guard the format.
-- Every change also appends the full options value (with "colors") to "report_options_history" (the audit row),
-- and freezes carry it in "ReportSnapshot"."optionsJson", so a frozen report keeps the colors it was frozen with.
-- Snapshots frozen before this migration have no colors there and keep the light gray bars they were sent with.
--
-- Rollback (the previous deployment never reads these columns):
--   ALTER TABLE "report_options" DROP COLUMN "headerBand";
--   ALTER TABLE "report_options" DROP COLUMN "barColor";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '0027_report_colors';

ALTER TABLE "report_options" ADD COLUMN "barColor" TEXT NOT NULL DEFAULT 'navy';
ALTER TABLE "report_options" ADD COLUMN "headerBand" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "report_options" ADD CONSTRAINT "report_options_barColor_check"
  CHECK ("barColor" IN ('navy', 'deeper-plum', 'plum') OR "barColor" ~ '^#[0-9A-F]{6}$');
ALTER TABLE "report_options" ADD CONSTRAINT "report_options_headerBand_check"
  CHECK ("headerBand" IN ('none', 'navy', 'deeper-plum', 'plum') OR "headerBand" ~ '^#[0-9A-F]{6}$');
