/** A fetch reply as the AI clients see it. `headers` is optional so test fakes can leave it out. */
export interface AiCappedReply {
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
}

/**
 * Size caps on provider replies. A declared content-length over the cap is refused before the body is read; the body
 * is checked again after reading because the header can be missing or wrong. Returns null when the reply is too large,
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
    const body = await res.text();
    return body.length > max ? null : body;
  }
}
