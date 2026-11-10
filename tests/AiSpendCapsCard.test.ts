import { describe, expect, it, vi } from "vitest";
import type { AiSpendCapView } from "@/lib/services/AiSpendCapService";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/aiSpendCaps", () => ({ setAiSpendCap: vi.fn() }));

// Admin > AI settings > Monthly spend caps. Fictional people and amounts only.
const VIEW: AiSpendCapView = {
  ready: true,
  defaultCapUsd: 10,
  people: [
    { email: "ana@example.test", spentUsd: 12, ownCapUsd: 25, effective: { capUsd: 25, source: "own" } },
    { email: "ben@example.test", spentUsd: 10, ownCapUsd: null, effective: { capUsd: 10, source: "default" } },
  ],
};

async function render(view: AiSpendCapView, dbReady = true): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { AiSpendCapsCard } = await import("@/components/AiSpendCapsCard");
  return renderToStaticMarkup(createElement(AiSpendCapsCard, { view, dbReady, names: { "ana@example.test": "Ana Example" } }));
}

/** The value attribute of the input whose tag contains `marker` (attribute order is React's, not ours). */
function inputValue(html: string, marker: string): string | undefined {
  const tag = html.match(/<input[^>]*>/g)?.find((t) => t.includes(marker));
  return tag?.match(/value="([^"]*)"/)?.[1];
}

describe("AiSpendCapsCard", () => {
  it("each input shows the saved amount from the server (a cap set from the Set cap row shows in its person's row)", async () => {
    const html = await render(VIEW);
    expect(inputValue(html, 'data-testid="ai-spend-default"')).toBe("10.00");
    expect(inputValue(html, "Own cap for ana@example.test")).toBe("25.00");
    expect(inputValue(html, "Own cap for ben@example.test")).toBe("");
    // A later refresh with a new cap for Ben renders it, not a blank left over from before.
    const after = await render({ ...VIEW, people: [VIEW.people[0], { ...VIEW.people[1], ownCapUsd: 5, effective: { capUsd: 5, source: "own" } }] });
    expect(inputValue(after, "Own cap for ben@example.test")).toBe("5.00");
  });

  it("marks a person at their cap and labels a default cap", async () => {
    const html = await render(VIEW);
    expect(html).toContain("Ana Example");
    expect(html).toContain("$10.00 (default)");
    expect(html).toMatch(/text-danger">\$10\.00</);
  });

  it("is read-only before 0074 is applied", async () => {
    const html = await render({ ...VIEW, ready: false });
    expect(html.match(/<input[^>]*disabled=""/g)?.length).toBe(html.match(/<input/g)?.length);
  });
});
