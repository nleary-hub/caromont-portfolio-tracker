import { describe, expect, it, vi } from "vitest";
import type { AiSpendCapView } from "@/lib/services/AiSpendCapService";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/aiSpendCaps", () => ({ setAiSpendCap: vi.fn() }));

const VIEW: AiSpendCapView = {
  ready: true,
  providers: [
    { provider: "openai", label: "OpenAI", spentUsd: 12, capUsd: 10 },
    { provider: "anthropic", label: "Anthropic", spentUsd: 0, capUsd: null },
    { provider: "xai", label: "xAI", spentUsd: 0, capUsd: null },
    { provider: "other", label: "Other", spentUsd: 0, capUsd: null },
    { provider: "azure_openai", label: "Azure OpenAI", spentUsd: 0, capUsd: null },
  ],
  previousPeople: [{ email: "ana@example.test", capUsd: 25 }],
  previousDefaultUsd: 10,
};

async function render(view: AiSpendCapView, dbReady = true): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { AiSpendCapsCard } = await import("@/components/AiSpendCapsCard");
  return renderToStaticMarkup(createElement(AiSpendCapsCard, { view, dbReady, names: { "ana@example.test": "Ana Example" } }));
}

function inputValue(html: string, marker: string): string | undefined {
  const tag = html.match(/<input[^>]*>/g)?.find((t) => t.includes(marker));
  return tag?.match(/value="([^"]*)"/)?.[1];
}

describe("AiSpendCapsCard", () => {
  it("each company input shows the saved shared cap", async () => {
    const html = await render(VIEW);
    expect(inputValue(html, 'data-testid="ai-spend-cap-openai"')).toBe("10.00");
    expect(inputValue(html, 'data-testid="ai-spend-cap-anthropic"')).toBe("");
    expect(html).toContain("Ana Example: $25.00");
    expect(html).toContain("Old default: $10.00");
    expect(html).toContain("not enforced");
  });

  it("marks a company at its cap", async () => {
    const html = await render(VIEW);
    expect(html).toMatch(/text-danger">\$12\.00</);
  });

  it("is read-only before 0075 is applied", async () => {
    const html = await render({ ...VIEW, ready: false });
    expect(html.match(/<input[^>]*disabled=""/g)?.length).toBe(html.match(/<input/g)?.length);
  });
});
