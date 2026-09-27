/** Select options for a per-line pick-list. */
export class PickList {
  /**
   * The line's options, plus the stored value when it is not one of them (grandfathered: a value saved before
   * the list changed stays selectable and is not silently cleared).
   */
  static withCurrent<T extends string>(options: readonly T[], current: T | null | undefined): T[] {
    return current && !options.includes(current) ? [...options, current] : [...options];
  }
}
