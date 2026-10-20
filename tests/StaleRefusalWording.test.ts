import { describe, expect, it } from "vitest";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";

describe("stale-value refusal wording", () => {
  it("a blank or To assign value reads as cleared", () => {
    expect(C.fieldChanged("Owner", "")).toBe("Owner was cleared after this suggestion was made. Nothing was saved. Ask again for a fresh suggestion.");
    expect(C.fieldChanged("Owner", "To assign")).toBe("Owner was cleared after this suggestion was made. Nothing was saved. Ask again for a fresh suggestion.");
  });
  it("a real value still names what it is now", () => {
    expect(C.fieldChanged("Owner", "Sample Person")).toBe("Owner was changed after this suggestion was made (it is now Sample Person). Nothing was saved. Ask again for a fresh suggestion.");
  });
});
