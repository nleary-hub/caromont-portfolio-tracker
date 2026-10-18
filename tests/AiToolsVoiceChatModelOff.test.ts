import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAiVoiceChat, proposeAiVoiceEdits, endAiVoiceChat } from "@/app/actions/aiTools";
import { AiVoiceChatPanel } from "@/components/AiVoiceChatPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";

/**
 * Step 10, pre-merge check (CTO, Oct 15): with no voice model enabled, voice chat shows the clean greyed model-off
 * state, no error, and pressing Start makes no connection attempt at all: no client secret request (server action or
 * fetch), no WebRTC, no microphone. The JSX runtime is wrapped only to capture the real Start button's onClick from a
 * server render, so the handler under test is the component's own.
 */
const captured = vi.hoisted(() => ({}) as { start?: () => unknown });
vi.mock("react/jsx-runtime", async (orig) => {
  const real = await orig<typeof import("react/jsx-runtime")>();
  const wrap = (fn: typeof real.jsx) => (type: Parameters<typeof real.jsx>[0], props: Record<string, unknown>, key?: string) => {
    if (type === "button" && props?.["data-testid"] === "ai-voice-start") captured.start = props.onClick as () => unknown;
    return fn(type, props, key);
  };
  return { ...real, jsx: wrap(real.jsx), jsxs: wrap(real.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (orig) => {
  const real = await orig<typeof import("react/jsx-dev-runtime")>();
  type Dev = typeof real.jsxDEV;
  const jsxDEV = ((type: Parameters<Dev>[0], props: Record<string, unknown>, ...rest: unknown[]) => {
    if (type === "button" && props?.["data-testid"] === "ai-voice-start") captured.start = props.onClick as () => unknown;
    return (real.jsxDEV as (...a: unknown[]) => unknown)(type, props, ...rest);
  }) as Dev;
  return { ...real, jsxDEV };
});
vi.mock("@/app/actions/aiActions", () => ({ runAiActionTool: vi.fn(), proposeAiActions: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn(), undoLastAiApply: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ proposeAiToolChanges: vi.fn(), applyAiToolLine: vi.fn(), rejectAiToolLine: vi.fn(), transcribeAiDictation: vi.fn(), startAiVoiceChat: vi.fn(), proposeAiVoiceEdits: vi.fn(), endAiVoiceChat: vi.fn(), reportAiVoiceFailure: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

describe("step 10: no voice model enabled", () => {
  it("renders the greyed model-off state with no error and never connects when Start is pressed", async () => {
    const getUserMedia = vi.fn();
    const RTCPeerConnection = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("window", {});
    vi.stubGlobal("RTCPeerConnection", RTCPeerConnection);
    vi.stubGlobal("fetch", fetchSpy);

    const html = renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: AiToolsCopy.MODEL_OFF_NOTE }));
    // Greyed and still focusable, tied to the note.
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*aria-describedby="ai-voice-off"[^>]*data-testid="ai-voice-start"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*data-testid="ai-voice-start"/);
    expect(html).toMatch(/<p id="ai-voice-off"[^>]*>The AI model is turned off\. An admin can turn one on in AI settings\.<\/p>/);
    // No error of any kind.
    expect(html).not.toContain('data-testid="ai-voice-error"');
    expect(html).not.toContain('role="alert"');
    for (const msg of [AiToolsCopy.VOICE_NO_MIC, AiToolsCopy.VOICE_START_FAILED, AiToolsCopy.VOICE_DROPPED, AiToolsCopy.VOICE_SESSION_GONE]) expect(html).not.toContain(msg.replace(/'/g, "&#x27;"));
    expect(html).not.toContain(AiToolsCopy.VOICE_LISTENING);

    // Press Start (the component's own handler): nothing is called.
    expect(captured.start).toBeTypeOf("function");
    await captured.start!();
    await new Promise((r) => setTimeout(r, 0));
    expect(startAiVoiceChat).not.toHaveBeenCalled();
    expect(proposeAiVoiceEdits).not.toHaveBeenCalled();
    expect(endAiVoiceChat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(RTCPeerConnection).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("the same handler does try to connect when the model is on (so the check above is meaningful)", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("window", {});
    vi.stubGlobal("RTCPeerConnection", vi.fn());
    captured.start = undefined;
    renderToStaticMarkup(createElement(AiVoiceChatPanel, { disabledNote: null }));
    await captured.start!();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(startAiVoiceChat).not.toHaveBeenCalled();
  });
});
