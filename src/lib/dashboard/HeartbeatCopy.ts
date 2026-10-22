/** Dashboard heartbeat copy. Since Oct 22, 2026 a global admin setting (Admin > Settings), no longer in the account menu. */
export class HeartbeatCopy {
  static readonly LABEL = "Dashboard heartbeat";
  static readonly HELP = "Shows the moving line and tile glow on the dashboard.";
  static readonly HELP_REDUCED = "Your device has reduced motion on, so the line stays still.";
  /** Admin > Settings > Dashboard heartbeat: the global switch (Oct 22, 2026). Draft wording, for Writing Bot. */
  static readonly ADMIN_HELP = "Shows the moving line and tile glow on the dashboard for everyone. Off by default. Devices with reduced motion on see the line stay still.";
  /** Inline, under the switch, when saving failed. Draft wording, for Writing Bot. */
  static readonly SAVE_FAILED = "Couldn't save this setting. Try again.";
}
