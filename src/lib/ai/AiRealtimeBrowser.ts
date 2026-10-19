import type { AiLiveBackendUsage } from "./AiLiveClient";
import { AiVoiceTranscript } from "./AiVoiceTranscript";
import { AiRealtimeClient, type AiRealtimeErrorInfo, type AiRealtimeTicket } from "./AiRealtimeClient";

/** The WebRTC handshake failed. Carries OpenAI's status and scrubbed error so the panel can report it for the log. */
export class AiRealtimeConnectError extends Error {
  constructor(readonly info: AiRealtimeErrorInfo & { modelUnavailable: boolean }) {
    super("realtime connect failed");
    this.name = "AiRealtimeConnectError";
  }
}

export type AiVoicePhase = "listening" | "speaking";

export interface AiRealtimeHandlers {
  onPhase(phase: AiVoicePhase): void;
  /** A transcript event (on screen only): who spoke, the text, and whether their line is finished. */
  onTranscript?(who: "you" | "ai", text: string, final: boolean): void;
  /** The model asked to suggest changes; return the text sent back to it as the tool result. */
  onToolCall(name: string, args: string): Promise<string>;
  onDropped(): void;
  /** ICE failed, or dropped before any media flowed: the network is likely blocking live audio. */
  onIceFailed(state: string): void;
}

export interface AiRealtimeConnection {
  /** Live: sends session.close and waits briefly for session.closed (final usage) before hanging up. */
  close(): Promise<void> | void;
  /** Live only: backend Responses usage seen so far (tokens; logged separately from the voice duration). */
  backendUsage(): AiLiveBackendUsage | null;
}

/**
 * Step 10, browser side of the realtime adapter (WebRTC). The microphone track goes to the provider and the answer
 * plays through an audio element; neither is recorded, buffered to a Blob or sent to this app's server. Only the
 * tool call text (the suggested changes) comes back here. Handles both voice APIs by ticket.api: Realtime events
 * (gpt-realtime*) and Live events (gpt-live-*, AiLiveClient). Not verified live against a specific model.
 */
export class AiRealtimeBrowser {
  static readonly LIVE_CLOSE_WAIT_MS = 3000;

  static supported(): boolean {
    return typeof window !== "undefined" && typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  static async connect(ticket: AiRealtimeTicket, mic: MediaStream, h: AiRealtimeHandlers, sessionId: string): Promise<AiRealtimeConnection> {
    const pc = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0];
    };
    for (const t of mic.getAudioTracks()) pc.addTrack(t, mic);
    const dc = pc.createDataChannel("oai-events");
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      dc.close();
      pc.close();
      mic.getTracks().forEach((t) => t.stop());
      audio.srcObject = null;
    };
    const live = ticket.api === "live";
    const usage: AiLiveBackendUsage = { responses: 0, inputTokens: 0, outputTokens: 0 };
    let onClosed: (() => void) | null = null;
    const send = (o: object) => {
      if (!closed && dc.readyState === "open") dc.send(JSON.stringify(o));
    };
    dc.onmessage = async (m) => {
      let e: { type?: string; delta?: unknown; transcript?: unknown; name?: string; call_id?: string; arguments?: string; event?: { type?: string; item?: { type?: string; name?: string; call_id?: string; arguments?: string }; response?: { usage?: { input_tokens?: number; output_tokens?: number } } } };
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      const said = AiVoiceTranscript.read(e);
      if (said) h.onTranscript?.(said.who, said.text, said.final);
      if (live) {
        // Live API events (gpt-live-*): transcripts drive the phase; tool calls arrive from the Responses backend.
        if (e.type === "session.input_transcript.delta") h.onPhase("listening");
        else if (e.type === "session.output_transcript.delta") h.onPhase("speaking");
        else if (e.type === "session.closed") onClosed?.();
        else if (e.type === "response.event" && e.event?.type === "response.completed") {
          const u = e.event.response?.usage;
          usage.responses += 1;
          usage.inputTokens += typeof u?.input_tokens === "number" ? u.input_tokens : 0;
          usage.outputTokens += typeof u?.output_tokens === "number" ? u.output_tokens : 0;
        } else if (e.type === "response.event" && e.event?.type === "response.output_item.done" && e.event.item?.type === "function_call" && e.event.item.name && e.event.item.call_id) {
          const item = e.event.item;
          const output = await h.onToolCall(item.name!, item.arguments ?? "");
          send({ type: "response.item.create", item: { type: "function_call_output", call_id: item.call_id, output } });
          send({ type: "response.create" });
        }
        return;
      }
      if (e.type === "input_audio_buffer.speech_started") h.onPhase("listening");
      else if (e.type === "output_audio_buffer.started" || e.type === "response.output_audio.delta") h.onPhase("speaking");
      else if (e.type === "output_audio_buffer.stopped" || e.type === "response.done") h.onPhase("listening");
      else if (e.type === "response.function_call_arguments.done" && e.name && e.call_id) {
        const output = await h.onToolCall(e.name, e.arguments ?? "");
        if (closed) return;
        dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output } }));
        dc.send(JSON.stringify({ type: "response.create" }));
      }
    };
    // media: ICE reached connected at least once, so audio could flow. A failure before that is ice_failed, after it a drop.
    let media = false;
    const drop = (state: string) => {
      if (closed) return;
      close();
      if (media) h.onDropped();
      else h.onIceFailed(state);
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === "connected" || s === "completed") media = true;
      else if (s === "failed" || s === "disconnected") drop(s);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") media = true;
      else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") drop(pc.connectionState);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // The offer goes to this app's route. Realtime: forwarded with the same short-lived client secret. Live: the server
    // starts the Live session (no browser token exists; clientSecret is ""). The API key is never in the browser.
    let res: Response;
    try {
      res = await fetch(ticket.callsUrl, {
        method: "POST",
        body: JSON.stringify({ sessionId, clientSecret: ticket.clientSecret, sdp: offer.sdp }),
        headers: { "content-type": "application/json" },
      });
    } catch (e) {
      close();
      throw new AiRealtimeConnectError({ type: (e as Error)?.name ?? "network", message: AiRealtimeClient.scrub(String((e as Error)?.message ?? ""), [ticket.clientSecret]), modelUnavailable: false });
    }
    if (!res.ok) {
      close();
      const info = AiRealtimeClient.safeError(res.status, await res.text().catch(() => ""), [ticket.clientSecret]);
      throw new AiRealtimeConnectError({ ...info, modelUnavailable: AiRealtimeClient.modelUnavailable(info) });
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    h.onPhase("listening");
    // Live: graceful close (session.close, then wait for session.closed so OpenAI finalizes usage), capped at 3 s.
    const end = async () => {
      if (live && !closed && dc.readyState === "open") {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, AiRealtimeBrowser.LIVE_CLOSE_WAIT_MS);
          onClosed = () => {
            clearTimeout(t);
            resolve();
          };
          send({ type: "session.close" });
        });
      }
      close();
    };
    return { close: end, backendUsage: () => (live && (usage.responses || usage.inputTokens || usage.outputTokens) ? { ...usage } : null) };
  }
}
