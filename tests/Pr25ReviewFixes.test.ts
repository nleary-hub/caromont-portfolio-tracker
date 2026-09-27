import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ContractsLeadRules } from "@/lib/people/ContractsLeadRules";
import { PeopleListRules } from "@/lib/people/PeopleListRules";
import { DepartmentForms } from "@/lib/services/DepartmentForms";
import { PeopleService } from "@/lib/services/PeopleService";
import { ProjectPeopleForms } from "@/lib/services/ProjectPeopleForms";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }), usePathname: () => "/" }));
vi.mock("@/app/actions/departments", () => ({
  addContractsLead: async () => ({ ok: true, message: "" }),
  removeContractsLead: async () => ({ ok: true, message: "" }),
  addPerson: async () => ({ ok: true, message: "" }),
  renamePerson: async () => ({ ok: true, message: "" }),
  removePerson: async () => ({ ok: true, message: "" }),
}));

const ADMIN = Factory.ADMIN;
const EDITOR = { email: "editor@example.org", isAdmin: false } as const;
const ROOT = path.resolve(__dirname, "..");

class F {
  static scope(db: PrismaClient) {
    return ServiceLineAccess.defaultLine(db);
  }

  static project(db: PrismaClient, owner: string | null = null) {
    return ProjectService.create({ name: "A", serviceArea: "Cath", owner, status: "OnTrack", nextMilestone: "M1" } as never, { changedBy: ADMIN.email }, db);
  }

  static files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      if (n === "generated" || n === "node_modules") return [];
      return statSync(p).isDirectory() ? F.files(p) : [p];
    });
  }
}

describe("1. Blocked names: neutral copy, no employment status anywhere", () => {
  it("uses the review copy for Add and Rename", async () => {
    expect(PeopleListRules.BLOCKED).toBe("That name can't be added to this list.");
    const fake = new FakeDb();
    const db = fake.asClient();
    expect(await DepartmentForms.addPerson(ADMIN, "owner", "Mark Wingard", db)).toMatchObject({ ok: false, message: "That name can't be added to this list." });
    expect(await DepartmentForms.renamePerson(ADMIN, "owner", "Nick Leary", "mark garland", db)).toMatchObject({ ok: false, message: "That name can't be added to this list." });
  });

  it("no text about anyone's employment in the app, migrations or tests", () => {
    const pattern = new RegExp(["no longer " + "work", "left " + "CaroMont", "former " + "employee"].join("|"), "i");
    const hits = [...F.files(path.join(ROOT, "src")), ...F.files(path.join(ROOT, "prisma")), ...F.files(path.join(ROOT, "tests"))].filter((f) => /\.(ts|tsx|sql|prisma)$/.test(f) && pattern.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("2. Rename dialog body", () => {
  it("count, Changed on the next report, frozen reports; singular and zero forms", () => {
    expect(PeopleListRules.renameBody("owner", "Mark Garland", 8)).toBe("8 projects list Mark Garland as owner. They'll show as Changed on the next report. Frozen reports keep the old name.");
    expect(PeopleListRules.renameBody("owner", "Mark Garland", 1)).toBe("1 project lists Mark Garland as owner. It'll show as Changed on the next report. Frozen reports keep the old name.");
    expect(PeopleListRules.renameBody("owner", "Mark Garland", 0)).toBe("No projects use this name yet. Frozen reports keep the old name.");
    expect(PeopleListRules.renameBody("owner", "Mark Garland", 0)).not.toContain("Changed");
  });
});

describe("3. Contracts leads A to Z on Admin > People and in the drawer picker (display only)", () => {
  it("admin list and picker sort; the stored order, import messages and validation keep the list order", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await F.scope(db);
    expect(scope.contractsLeads).toEqual(["Shea Waldron", "Jeff Krause", "Mellisa Gonzales", "Dave Dermady", "Amber Hatley"]);
    const rows = await PeopleService.contractsLeads(scope, ADMIN, db);
    expect(rows.map((r) => r.name)).toEqual(["Amber Hatley", "Dave Dermady", "Jeff Krause", "Mellisa Gonzales", "Shea Waldron"]);
    expect(ContractsLead.pickerOptions(scope.contractsLeads)).toEqual(["Amber Hatley", "Dave Dermady", "Jeff Krause", "Mellisa Gonzales", "Shea Waldron"]);
    // Adding appends to the stored list as before; nothing is re-sorted in the database.
    await DepartmentForms.addContractsLead(ADMIN, "Bea Cole", db);
    expect((await F.scope(db)).contractsLeads.at(-1)).toBe("Bea Cole");
    expect(ContractsLead.options(scope.contractsLeads)).toEqual(scope.contractsLeads);
    expect(ContractsLead.invalidMessage("X", scope.contractsLeads)).toContain("Shea Waldron, Jeff Krause, Mellisa Gonzales, Dave Dermady, Amber Hatley");
    // The frozen seed and sample data keep their order.
    expect(ServiceLine.CVPSL_CONTRACTS_LEADS[0]).toBe("Shea Waldron");
  });

  it("the drawer's Contracts lead select lists A to Z", async () => {
    const { ProjectPeopleEditor } = await import("@/components/ProjectPeopleEditor");
    const html = renderToStaticMarkup(
      createElement(ProjectPeopleEditor, {
        projectId: "p",
        owner: null,
        physicianChampion: null,
        requesterNotApplicable: false,
        contractsLead: null,
        serviceArea: null,
        ownerSuggestions: [],
        requesterSuggestions: [],
        saveAction: async () => null,
        contractsLeads: ["Shea Waldron", "Amber Hatley", "Jeff Krause"],
      }),
    );
    const select = html.slice(html.indexOf('name="contractsLead"'), html.indexOf("</select>", html.indexOf('name="contractsLead"')));
    expect([...select.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(["", "Amber Hatley", "Jeff Krause", "Shea Waldron"]);
  });
});

describe("4. Only an admin's Add 'X' adds the name to the line's list", () => {
  it("admin: the project gets the name and the list gains it", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await F.project(db);
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "Jeff Krause", db)).toEqual({ ok: true });
    expect(fake.state.projects.find((x) => x.id === p.id)!.owner).toBe("Jeff Krause");
    expect((await F.scope(db)).owners).toContain("Jeff Krause");
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "physicianChampion", "Dr. Adams", db)).toEqual({ ok: true });
    expect((await F.scope(db)).requesters).toEqual(["Dr. Adams"]);
  });

  it("non-admin: rejected server-side; neither the project nor the list changes", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await F.project(db);
    const before = (await F.scope(db)).owners;
    expect(await ProjectPeopleForms.setField(EDITOR, p.id, "owner", "Jeff Krause", db)).toEqual({ ok: false, error: "Not authorized." });
    expect(await ProjectPeopleForms.setField(null, p.id, "owner", "Jeff Krause", db)).toEqual({ ok: false, error: "Not authorized." });
    expect(fake.state.projects.find((x) => x.id === p.id)!.owner).toBeNull();
    expect((await F.scope(db)).owners).toEqual(before);
  });

  it("the list step itself refuses non-admins, so a future non-admin edit path sets the project value only", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await F.scope(db);
    expect(await PeopleService.rememberPerson(scope, "owner", "Jeff Krause", EDITOR, db)).toBe(false);
    expect(await PeopleService.rememberPerson(scope, "requester", "Dr. Adams", EDITOR, db)).toBe(false);
    expect((await F.scope(db)).owners).toEqual(scope.owners);
    expect((await F.scope(db)).requesters).toEqual([]);
    expect(fake.state.serviceLineHistory).toEqual([]);
  });

  it("admin with a blocked name: the project keeps it, the list doesn't gain it", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await F.project(db);
    expect(await ProjectPeopleForms.setField(ADMIN, p.id, "owner", "Mark Wingard", db)).toEqual({ ok: true });
    expect((await F.scope(db)).owners).not.toContain("Mark Wingard");
  });

  it("the server action delegates to ProjectPeopleForms", () => {
    const src = readFileSync(path.join(ROOT, "src/app/actions/admin.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function setProjectPeopleField"), src.indexOf("export async function deleteProject"));
    expect(fn).toContain("ProjectPeopleForms.setField(await CurrentViewer.get()");
    expect(fn).not.toContain("rememberPerson");
  });
});

describe("5. Duplicate errors use the right article", () => {
  it("an owner, a requester, a contracts lead (stored spelling)", async () => {
    expect(PeopleListRules.duplicate("owner", "Nicole Smith")).toBe("Nicole Smith is already an owner.");
    expect(PeopleListRules.duplicate("requester", "Nicole Smith")).toBe("Nicole Smith is already a requester.");
    expect(ContractsLeadRules.duplicate("Jeff Krause")).toBe("Jeff Krause is already a contracts lead.");
    const fake = new FakeDb();
    const db = fake.asClient();
    await DepartmentForms.addPerson(ADMIN, "requester", "Nicole Smith", db);
    expect(await DepartmentForms.addPerson(ADMIN, "owner", "nicole smith", db)).toMatchObject({ ok: false, message: "Nicole Smith is already an owner." });
    expect(await DepartmentForms.addPerson(ADMIN, "requester", "NICOLE SMITH", db)).toMatchObject({ ok: false, message: "Nicole Smith is already a requester." });
    expect(await DepartmentForms.addContractsLead(ADMIN, "jeff  krause", db)).toMatchObject({ ok: false, message: "Jeff Krause is already a contracts lead." });
  });
});

describe("6. Locked rows are as tall as name rows", () => {
  it("locked rows get a 28px slot in the actions cell, the size of the row menu button", async () => {
    const { PeopleAdmin } = await import("@/components/PeopleAdmin");
    const html = renderToStaticMarkup(
      createElement(PeopleAdmin, {
        lineShort: "CVPSL",
        leads: [],
        owners: [
          { name: "To assign", projects: 1, locked: true },
          { name: "Jeff Krause", projects: 1, locked: false },
        ],
        requesters: [],
      }),
    );
    const slot = html.match(/<div class="relative inline-block align-middle" aria-hidden="true" data-testid="people-locked-slot"><span class="block h-7 w-7"><\/span><\/div>/g);
    expect(slot).toHaveLength(1);
    const css = readFileSync(path.join(ROOT, "src/styles/dashboard-filters.css"), "utf8");
    expect(css).toMatch(/\.df-icon-btn \{\s*width: 28px; height: 28px;/);
  });
});
