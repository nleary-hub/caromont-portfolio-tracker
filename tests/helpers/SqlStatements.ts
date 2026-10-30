// Splits a migration file into top-level statements, the way Prisma 7.4+ sends a parseable PostgreSQL migration (one
// statement at a time). Skips -- and /* */ comments; respects '...', "..." and $tag$...$tag$ bodies, so a plpgsql BEGIN
// inside a DO block is never read as a transaction statement. Test helper only.
export function sqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j += 1;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const tag = c === "$" ? /^\$[A-Za-z_]*\$/.exec(sql.slice(i)) : null;
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      const stop = end === -1 ? sql.length : end + tag[0].length;
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
      cur = "";
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, " "));
  return out;
}
