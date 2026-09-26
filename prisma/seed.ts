/**
 * LOCAL DEVELOPMENT ONLY: seeds fictional "Sample:" projects so the dashboard has data.
 * Refuses to run in production or against a database that already has projects.
 * Usage: npm run db:seed
 */
import "dotenv/config";
import { Db } from "@/lib/db/Db";
import { ProjectService } from "@/lib/services/ProjectService";
import type { ProjectInput } from "@/lib/validation/ProjectValidator";

class Seed {
  static readonly ACTOR = { changedBy: "seed@localhost", comment: "Sample data" };

  static readonly PROJECTS: ProjectInput[] = [
    { name: "Sample: Cath lab 3 refresh", serviceArea: "Cath", owner: "Owner A", physicianChampion: "Dr. Sample A", status: "OnTrack", nextMilestone: "Equipment install complete", dueDate: "2026-10-21", note: "Vendor install scheduled for 10/14; super-user training booked the week prior. No blockers." },
    { name: "Sample: Radial lounge expansion", serviceArea: "Cath", owner: "Owner B", physicianChampion: "Dr. Sample B", status: "AtRisk", nextMilestone: "Construction bid award", dueDate: "2026-09-20", note: "Bids came in 18% over budget; scope cut to 6 bays from 8, and rebid due 10/12. Award slips to 10/19, pushing opening to January. Need Dr. Sample B and finance to approve revised scope by 10/9, please." },
    { name: "Sample: Same-day discharge PCI pathway", serviceArea: "Cath", owner: "Owner C", status: "NotStarted", nextMilestone: "Kickoff meeting", dueDate: "2026-11-04", note: "Awaiting physician champion assignment before scheduling kickoff." },
    { name: "Sample: EP lab mapping system upgrade", serviceArea: "EP", owner: "Owner D", physicianChampion: "Dr. Sample C", status: "OffTrack", nextMilestone: "Vendor contract signed", dueDate: "2026-09-18", note: "Go-live moved to 11/3 because the IT interface build slipped two weeks." },
    { name: "Sample: Pulsed field ablation launch", serviceArea: "EP", owner: "Owner A", physicianChampion: "Dr. Sample D", status: "OnTrack", nextMilestone: "First cases scheduled", dueDate: "2026-10-28", note: "Credentialing complete for two operators." },
    { name: "Sample: Echo structured reporting update", serviceArea: "Echo", owner: "Owner E", physicianChampion: "Dr. Sample E", status: "Complete", nextMilestone: "Go-live", dueDate: "2026-09-15", note: "Templates live in all reading rooms." },
    { name: "Sample: CVSS post-op handoff checklist", serviceArea: "CVSS", owner: "Owner F", physicianChampion: "Dr. Sample F", status: "OnHold", nextMilestone: "Pilot restart", dueDate: "2026-11-18", note: "Paused until unit staffing stabilizes." },
    { name: "Sample: INU bed flow redesign", serviceArea: "INU", owner: "Owner G", physicianChampion: "Dr. Sample G", status: "OnTrack", nextMilestone: "Workflow sign-off", dueDate: "2026-10-16" },
    { name: "Sample: Syncope clinic referral pathway", serviceArea: "CardioNeuro", owner: "Owner H", physicianChampion: "Dr. Sample H", status: "AtRisk", nextMilestone: "Referral criteria approval", dueDate: "2026-10-14" },
    { name: "Sample: IR suite scheduling consolidation", serviceArea: "IR", owner: "Owner B", physicianChampion: "Dr. Sample J", status: "Cancelled", note: "Folded into the enterprise scheduling project." },
  ];

  static async run(): Promise<void> {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed in production");
    const db = Db.client;
    const existing = await db.project.count();
    if (existing > 0) {
      console.log(`Database already has ${existing} projects; not seeding.`);
      return;
    }
    for (const p of Seed.PROJECTS) await ProjectService.create(p, Seed.ACTOR, db);
    console.log(`Seeded ${Seed.PROJECTS.length} sample projects.`);
    await db.$disconnect();
  }
}

Seed.run().catch((e) => {
  console.error(e);
  process.exit(1);
});
