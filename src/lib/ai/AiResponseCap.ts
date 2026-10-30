/** A fetch reply as the AI clients see it. `headers` is optional so test fakes can leave it out. */
export interface AiCappedReply {
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  /** The streamed body (real fetch replies). When present the cap is enforced while reading. */
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> } } | null;
}

/**
 * Size caps on provider replies, in bytes. A declared content-length over the cap is refused before the body is read.
 * A streamed body is read chunk by chunk with a running byte count and cancelled as soon as the count passes the cap,
 * so a reply with no content-length (chunked) is never buffered past the cap. Replies without a stream (test fakes)
 * are checked after text(). Returns null when the reply is too large,
 * so each caller fails closed with its own existing error. Never logs the reply.
 */
export class AiResponseCap {
  /** Transcription JSON: a few minutes of dictated text. */
  static readonly TRANSCRIPTION_CHARS = 256_000;
  /** Voice: a session secret or an SDP answer. */
  static readonly VOICE_CHARS = 256_000;
  /** Provider model lists. */
  static readonly MODEL_LIST_CHARS = 2_000_000;

  static async text(res: AiCappedReply, max: number): Promise<string | null> {
    const declared = Number(res.headers?.get?.("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > max) return null;
    const reader = res.body?.getReader?.();
    if (!reader) {
      const body = await res.text();
      return new TextEncoder().encode(body).length > max ? null : body;
    }
    const decoder = new TextDecoder();
    let bytes = 0;
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? 0;
      if (bytes > max) {
        await reader.cancel("reply over the size cap").catch(() => undefined);
        return null;
      }
      if (value) out += decoder.decode(value, { stream: true });
    }
    return out + decoder.decode();
  }
}
