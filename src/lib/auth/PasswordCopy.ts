/** Copy for email and password sign-in: /signin, /set-password and Admin > People > Access. No em dashes. */
export class PasswordCopy {
  // Sign-in page
  static readonly DIVIDER = "or";
  static readonly EMAIL_LABEL = "Email";
  static readonly PASSWORD_LABEL = "Password";
  static readonly SHOW_PASSWORD = "Show password";
  static readonly HIDE_PASSWORD = "Hide password";
  static readonly SUBMIT = "Sign in";
  static readonly HELP = "An admin sets up password sign-in. Ask one if you need a password or a reset.";
  /** Wrong email, wrong password, no account, turned off: always this one message. */
  static readonly INVALID = "That email and password didn't work. Check them and try again.";
  static readonly LOCKED_TITLE = "Too many attempts";
  static readonly LOCKED = "Sign-in for this email is paused for 15 minutes. Try again then, or ask an admin to unlock it.";
  static readonly LIMITED_TITLE = "Slow down a little";
  static readonly LIMITED = "There have been a lot of sign-in attempts from here. Wait a few minutes, then try again.";
  static readonly ENDED_TITLE = "Your session ended";
  static readonly ENDED = "Sign in again to keep going.";

  // First sign-in: /set-password
  static readonly SET_TITLE = "Choose your password";
  static readonly SET_INTRO = "You signed in with a temporary password. Choose your own to keep going.";
  static readonly NEW_PASSWORD = "New password";
  static readonly CONFIRM_PASSWORD = "Confirm new password";
  static readonly RULE_LENGTH = "At least 12 characters";
  static readonly RULE_NOT_EMAIL = "Not your email address";
  static readonly RULE_MATCH = "Both entries match";
  static readonly SET_SUBMIT = "Save and continue";
  static readonly SAME_AS_TEMPORARY = "Choose a new password, not the temporary one.";

  // Password rules (server and client)
  static readonly TOO_SHORT = "Use at least 12 characters.";
  static readonly TOO_LONG = "Use 256 characters or fewer.";
  static readonly IS_EMAIL = "Don't use your email address as your password.";
  static readonly MISMATCH = "The passwords don't match.";
  static readonly SAVE_ERROR = "Couldn't save the password. Try again.";

  // Admin > People > Access
  static readonly TAG_PASSWORD = "Password";
  static readonly TAG_GOOGLE = "Google";
  static readonly TAG_GOOGLE_TIP = "Signs in with Google.";
  static readonly TAG_MUST_CHANGE = "Must change password";
  static readonly TAG_LOCKED = "Locked";
  static readonly TAG_OFF = "Off";
  static readonly TAG_PASSWORD_TIP = "Can sign in with email and password.";
  static readonly TAG_MUST_CHANGE_TIP = "Has a temporary password. They'll choose their own at their next sign-in.";
  static readonly TAG_LOCKED_TIP = "Too many wrong passwords. Unlocks by itself after 15 minutes.";
  static readonly TAG_OFF_TIP = "Sign-in is turned off for this person.";
  static readonly MENU_LABEL = "More actions";
  /** Access grid: the sign-in method tags (every method that works for the account) as a group. */
  static readonly METHODS_LABEL = "Sign-in methods";
  static readonly MENU_CREATE = "Create temporary password";
  static readonly MENU_UNLOCK = "Unlock";
  static readonly MENU_TURN_OFF = "Turn off sign-in";
  static readonly MENU_TURN_ON = "Turn on sign-in";

  static readonly ADD_TITLE = "Add user";
  static readonly ADD_NAME = "Name (optional)";
  static readonly ADD_LINES = "Service lines";
  static readonly ADD_NO_LINES = "No lines selected. They can sign in, but they won't see any projects until you give them a line.";
  static readonly ADD_TEMP = "Create a temporary password for email and password sign-in";
  static readonly ADD_TEMP_HELP = "Leave this off for people who sign in with Google.";
  static readonly ADD_SAVE = "Add user";
  static readonly UNKNOWN_LINE = "One of those service lines isn't available. Refresh and try again.";

  static readonly TEMP_TITLE = "Temporary password";
  static readonly TEMP_BODY = "This password is shown only once. Copy it now and share it by phone or in person. They'll choose their own password the first time they sign in.";
  static readonly COPY = "Copy";
  static readonly COPIED = "Copied";
  static readonly DONE = "Done";

  static readonly UNLOCKED_TOAST = "Unlocked. They can try again now.";
  static readonly NOT_SELF = "You can't turn off your own sign-in.";

  /** After Turn off sign-in (every provider, sessions end at their next check). */
  static turnedOffToast(name: string): string {
    return `${name} can't sign in now. Their sessions have ended.`;
  }

  static turnedOnToast(name: string): string {
    return `${name} can sign in again.`;
  }

  /** The temporary password dialog's title. */
  static tempDialogTitle(email: string): string {
    return `Create temporary password for ${email}`;
  }

  static tempFor(name: string): string {
    return `Temporary password for ${name}`;
  }

  static addedToast(email: string): string {
    return `${email} added.`;
  }
}
