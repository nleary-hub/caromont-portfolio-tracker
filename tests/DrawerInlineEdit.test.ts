import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(path.resolve(__dirname, "..", "src/components/ProjectDashboard.tsx"), "utf8");

describe("Project drawer: inline edit without an Edit click", () => {
  it("opens an admin's project drawer straight into the edit form", () => {
    expect(src).toMatch(/const openMode = \(id: string \| null\): DrawerMode => \(id && admin\?\.formValues\[id\] \? "edit" : "view"\)/);
    expect(src).toMatch(/useState<DrawerMode>\(\(\) => openMode\(initialProjectId \?\? null\)\)/);
    expect(src).toMatch(/leaveForm\(\);\s*setMode\(openMode\(id\)\);\s*setSelectedId\(id\);/);
  });

  it("stays editable after Save and Cancel closes through the discard guard", () => {
    expect(src).toMatch(/setMode\(created \? "view" : openMode\(id\)\)/);
    expect(src).toMatch(/onCancel=\{requestClose\}/);
  });

  it("keeps the Edit button only for view mode (non-admins never get it)", () => {
    expect(src).toMatch(/onEdit=\{admin && mode === "view" && admin\.formValues\[selected\.id\] \? \(\) => setMode\("edit"\) : undefined\}/);
  });
});
