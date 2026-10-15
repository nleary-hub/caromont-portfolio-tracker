/** Every user-facing string of the drawer Dependencies section (short and plain). */
export class DependencyCopy {
  static readonly TITLE = "Dependencies";
  static readonly CAPTION = "Saves as you pick";
  static readonly BLOCKED_BY = "Blocked by";
  static readonly NONE = "Not blocked by any project.";
  static readonly ADD_PLACEHOLDER = "Add a blocking project";
  static readonly SEARCH_PLACEHOLDER = "Search projects";
  static readonly NO_MATCH = "No matching projects";
  static readonly NO_OPTIONS = "No other projects to add";
  static readonly LOADING = "Loading…";
  static readonly LOAD_ERROR = "Could not load dependencies.";

  static remove(name: string): string {
    return `Remove ${name}`;
  }

  /** Drawer header tag: "Blocked by 2". */
  static count(n: number): string {
    return `${DependencyCopy.BLOCKED_BY} ${n}`;
  }
}
