/** One row as the table shows it (dates already formatted on the server). */
export interface DependencyReviewRowDto {
  id: string;
  project: string;
  blockedBy: string;
  created: string;
  createdBy: string;
}

export class DependencyReviewCopy {
  static readonly PAGE_TITLE = "Dependencies review";
  static readonly INTRO =
    "Every Blocked-by dependency in this service line, newest first. This page is read only. The Link button on AI Find related suggestions in the project drawer used to save the suggested project as Blocked by, so some of these rows may not be real dependencies. To fix one, open that project's drawer and edit it under Dependencies.";
  static readonly HEADERS = ["Project", "Blocked by", "Added", "Added by"] as const;
  static readonly EMPTY = "No dependencies yet.";
  static count(n: number): string {
    return n === 1 ? "1 dependency" : `${n} dependencies`;
  }
}

/** The page intro under the title, capped at about 72 characters per line for reading. */
export function DependencyReviewIntro() {
  return (
    <p className="max-w-[72ch] text-muted type-caption" data-testid="dependency-review-intro">
      {DependencyReviewCopy.INTRO}
    </p>
  );
}

/** Admin > Dependencies review: a read-only table (no buttons, links or forms). Dark, compact, glass card. */
export function DependencyReviewTable({ rows }: { rows: DependencyReviewRowDto[] }) {
  const C = DependencyReviewCopy;
  return (
    <section className="flex flex-col gap-2" aria-label={C.PAGE_TITLE} data-testid="dependency-review">
      {rows.length > 0 && (
        <span className="text-muted type-caption" data-testid="dependency-review-count">
          {C.count(rows.length)}
        </span>
      )}
      {rows.length === 0 ? (
        <p className="text-muted type-caption" data-testid="dependency-review-empty">
          {C.EMPTY}
        </p>
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-card/80 backdrop-blur-[20px]">
          <table className="w-full border-separate border-spacing-0 type-table">
            <thead>
              <tr className="text-left text-muted type-label uppercase">
                {C.HEADERS.map((h) => (
                  <th key={h} scope="col" className="border-b border-line px-3 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-testid="dependency-review-row">
                  <td className="border-b border-line px-3 py-2 type-table-strong">{r.project}</td>
                  <td className="border-b border-line px-3 py-2">{r.blockedBy}</td>
                  <td className="border-b border-line px-3 py-2 whitespace-nowrap">{r.created}</td>
                  <td className="border-b border-line px-3 py-2">{r.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
