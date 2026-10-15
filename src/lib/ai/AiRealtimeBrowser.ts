import type { AiRealtimeTicket } from "./AiRealtimeClient";

export type AiVoicePhase = "listening" | "speaking";

export interface AiRealtimeHandlers {
  onPhase(phase: AiVoicePhase): void;
  /** The model asked to suggest changes; return the text sent back to it as the tool result. */
  onToolCall(name: string, args: string): Promise<string>;
  onDropped(): void;
}

export interface AiRealtimeConnection {
  close(): void;
}

/**
 * Step 10, browser side of the realtime adapter (WebRTC). The microphone track goes to the provider and the answer
 * plays through an audio element; neither is recorded, buffered to a Blob or sent to this app's server. Only the
 * tool call text (the suggested changes) comes back here. The shape mirrors AiRealtimeClient and is not verified
 * live against gpt-live-1.
 */
export class AiRealtimeBrowser {
  static supported(): boolean {
    return typeof window !== "undefined" && typeof RTCPeerConnection !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  static async connect(ticket: AiRealtimeTicket, mic: MediaStream, h: AiRealtimeHandlers): Promise<AiRealtimeConnection> {
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
    pc.onconnectionstatechange = () => {
      if (!closed && (pc.connectionState === "failed" || pc.connectionState === "disconnected")) {
        close();
        h.onDropped();
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(`${ticket.callsUrl}?model=${encodeURIComponent(ticket.model)}`, {
      method: "POST",
      body: offer.sdp,
      headers: { authorization: `Bearer ${ticket.clientSecret}`, "content-type": "application/sdp" },
    });
    if (!res.ok) {
      close();
      throw new Error("realtime connect failed");
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
    h.onPhase("listening");
    return { close };
  }
}
