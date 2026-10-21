import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AiActionTools } from "@/lib/ai/actions/AiActionTools";

describe("Item 1: voice chat edit tools on the shared action layer", () => {
  it("offers propose, apply and undo from AiActionTools (confirm cards, stale-value check, logging)", () => {
    const names = AiVoiceChat.TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([AiActionTools.PROPOSE.name, AiActionTools.APPLY.name, AiActionTools.UNDO.name]));
    expect(names).not.toContain(AiVoiceChat.LEGACY_TOOL_NAME);
  });
  it("the built-in rules say voice can make changes, with review then apply; no can't-edit wording", () => {
    const t = AiVoiceChat.instructions([]);
    expect(t).toContain("make changes to them when asked");
    expect(t).toContain("saved only after the person says yes");
    expect(t).toContain(AiVoiceChat.TOOL_CONTRACT);
    expect(t).not.toMatch(/can(no|')t (edit|change)/i);
  });
  it("the panel runs every tool through runAiActionTool and shows the shared confirm card", () => {
    const src = readFileSync("src/components/AiVoiceChatPanel.tsx", "utf8");
    expect(src).toContain('runAiActionTool("voice_chat", name, args)');
    expect(src).toContain("<AiActionReview");
  });
});
