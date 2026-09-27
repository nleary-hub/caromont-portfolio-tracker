/** Writing Bot copy for per-service-line access (item 8): Admin > People > Access and the no-access cards. */
export class LineAccessCopy {
  static readonly NOTE = "Covers all service lines and departments. Admins can see everything.";
  static readonly ALL_LINES = "All lines";
  static readonly ADMIN_LOCK_TOOLTIP = "Admins can see every service line.";
  static readonly NO_ACCESS_TAG = "No access";
  static readonly NO_ACCESS_TOOLTIP = "Can't see any service line yet.";
  static readonly SAVE_ERROR = "Couldn't save access. Try again.";
  static readonly EMPTY = "No other users yet. Add someone by email, or they'll show up here after their first sign-in.";
  static readonly COLUMNS = { name: "Name", email: "Email" } as const;

  static readonly REMOVE_LAST_BODY = "They won't see any projects until an admin gives them access again.";
  static readonly REMOVE_LAST_BUTTON = "Remove access";
  static readonly CANCEL = "Cancel";

  static readonly ADD_USER = "Add user";
  static readonly ADD_FIELD = "Email";
  static readonly ADD_HELPER = "They'll see only the lines and departments you choose here.";
  static readonly ADD_BUTTON = "Add";
  static readonly INVALID_EMAIL = "Enter a valid email address.";
  static readonly DUPLICATE_EMAIL = "That email is already on the list.";
  static readonly NOT_ALLOWED_EMAIL = "That email can't sign in to this tracker.";

  static readonly NO_ACCESS_TITLE = "You don't have access yet";
  static readonly NO_ACCESS_BODY = "Ask an admin to add you to a service line.";
  static readonly SIGN_OUT = "Sign out";
  static readonly LINE_BODY = "Ask an admin if you need it.";

  static heading(count: number): string {
    return `Access (${count})`;
  }

  static checkboxLabel(name: string, shortName: string): string {
    return `${name}, ${shortName} access`;
  }

  static grantedToast(name: string, shortName: string): string {
    return `${name} can now see ${shortName}.`;
  }

  static revokedToast(name: string, shortName: string): string {
    return `${name} can no longer see ${shortName}.`;
  }

  static removeLastTitle(name: string): string {
    return `Remove ${name}'s last line?`;
  }

  static addedToast(email: string): string {
    return `${email} added.`;
  }

  static signedInAs(email: string): string {
    return `Signed in as ${email}`;
  }

  static lineTitle(shortName: string): string {
    return `You don't have access to ${shortName}`;
  }

  static goTo(shortName: string): string {
    return `Go to ${shortName}`;
  }
}
