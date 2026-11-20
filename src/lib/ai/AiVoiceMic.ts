type VoiceRecorder = { state: string; stop: () => void; onstop: unknown; ondataavailable: unknown } | null;
type VoiceStream = { getTracks: () => { stop: () => void }[] } | null;

/**
 * Stop a recording without running its upload callback, and release the microphone.
 * Used when the voice panel unmounts (the drawer closed, or the page navigated away).
 */
export function releaseVoiceMic(recorder: VoiceRecorder, stream: VoiceStream): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.onstop = null;
    recorder.ondataavailable = null;
    try {
      recorder.stop();
    } catch {
      // The recorder can already be stopping.
    }
  }
  stream?.getTracks().forEach((t) => t.stop());
}
