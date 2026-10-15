/** One stored edge: `projectId` is blocked by `blockedById`. */
export interface DependencyEdge {
  projectId: string;
  blockedById: string;
}

/** Why an edge can't be added. */
export type DependencyProblem = "self" | "duplicate" | "cycle";

/**
 * Pure rules for project dependencies (migration 0037). An edge A -> B means "A is blocked by B". Adding it is
 * rejected when A = B, when it already exists, or when B already depends on A through any chain (it would close a
 * cycle: A -> B -> ... -> A).
 */
export class DependencyGraph {
  /** Short, plain messages shown under the picker. */
  static readonly MESSAGES: Record<DependencyProblem, string> = {
    self: "A project can't block itself.",
    duplicate: "Already blocked by this project.",
    cycle: "That would make a loop. These projects already depend on each other.",
  };

  /** The problem with adding `projectId` blocked by `blockedById`, or null when it is allowed. */
  static check(edges: readonly DependencyEdge[], projectId: string, blockedById: string): DependencyProblem | null {
    if (projectId === blockedById) return "self";
    if (edges.some((e) => e.projectId === projectId && e.blockedById === blockedById)) return "duplicate";
    return DependencyGraph.reaches(edges, blockedById, projectId) ? "cycle" : null;
  }

  /** Whether `from` depends on `to` through one or more edges (iterative DFS, safe on any graph). */
  static reaches(edges: readonly DependencyEdge[], from: string, to: string): boolean {
    const next = new Map<string, string[]>();
    for (const e of edges) next.set(e.projectId, [...(next.get(e.projectId) ?? []), e.blockedById]);
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      for (const n of next.get(id) ?? []) {
        if (n === to) return true;
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    return false;
  }
}
