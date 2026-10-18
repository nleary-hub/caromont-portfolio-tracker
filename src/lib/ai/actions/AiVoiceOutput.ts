/** The apply or undo tool output as the screen needs it (the JSON the model also gets). */
export const AiVoiceOutput = {
  read(output: string, args: string = ""): { proposalId: string | null; applied: { line: number }[]; failed: { line: number; message: string }[]; summary: string | null } {
    const none = { proposalId: null, applied: [], failed: [], summary: null };
    try {
      const o = JSON.parse(output) as { ok?: boolean; applied?: unknown; failed?: unknown; summary?: unknown; proposalId?: unknown };
      if (!o || o.ok !== true) return none;
      const a = args ? (JSON.parse(args) as { proposalId?: unknown }) : {};
      const id = typeof o.proposalId === "string" ? o.proposalId : typeof a.proposalId === "string" ? a.proposalId : null;
      const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is { line: number; message: string } => !!x && typeof (x as { line?: unknown }).line === "number") : []);
      return { proposalId: id, applied: lines(o.applied), failed: lines(o.failed), summary: typeof o.summary === "string" ? o.summary : null };
    } catch {
      return none;
    }
  },
};
