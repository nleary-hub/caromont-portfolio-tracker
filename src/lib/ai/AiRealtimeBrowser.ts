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
  /** The model asked to suggest changes; return the text sent back to it as the tool result. */
  onToolCall(name: string, args: string): Promise<string>;
  onDropped(): void;
  /** ICE failed, or dropped before any media flowed: the network is likely blocking live audio. */
  onIceFailed(state: string): void;
}

export interface AiRealtimeConnection {
  close(): void;
}

/**
 * Step 10, browser side of the realtime adapter (WebRTC). The microphone track goes to the provider and the answer
 * plays through an audio element; neither is recorded, buffered to a Blob or sent to this app's server. Only the
 * tool call text (the suggested changes) comes back here. The shape mirrors AiRealtimeClient and is not verified
 * live against a specific realtime model.
 */
export class AiRealtimeBrowser {
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
    dc.onmessage = async (m) => {
      let e: { type?: string; name?: string; call_id?: string; arguments?: string };
      try {
        e = JSON.parse(String(m.data));
      } catch {
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
    // Hotfix: the offer goes to this app's route, which forwards it to OpenAI with the same short-lived client secret
    // (the browser's direct fetch to OpenAI failed in production). The API key is never in the browser.
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
    return { close };
  }
}
