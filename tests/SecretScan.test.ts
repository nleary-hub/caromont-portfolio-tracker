import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// K15: nobody pastes a real key into source, tests, fixtures, docs or migrations. The repository has no CI workflow folder, so the
// scan runs here, over every tracked file, on every test run. It looks for the common provider key shapes, a PEM header, a bearer
// token, a database URL that carries a password, and an unbroken run of 32 or more letters and digits that is not a hash.
// It is a backstop, not a full scanner. The patterns are written so that this file does not match itself.
const root = path.resolve(__dirname, "..");

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "sk-style key", re: /\bsk-(?:proj-|ant-|or-v1-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { name: "gsk_ key", re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { name: "xai- key", re: /\bxai-[A-Za-z0-9]{20,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: "PEM private key header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "database URL with a password", re: /\bpostgres(?:ql)?:\/\/[^\s:@/'"`]+:[^\s@/'"`]{3,}@(?!localhost|127\.0\.0\.1|[a-z0-9.-]*example)/i },
];
const LONG_RUN = /[A-Za-z0-9]{32,}/g;
const HEX_ONLY = /^[0-9a-f]+$/i;

/** Known harmless text: the comment examples in migration 0071 and its pre-flight (a custom name that merely looks like a key). */
const ALLOW = ["sk-claims-v2", "sk-summarizer2026", "sk-abcdefghij", "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "sk-another-key-1234567890", "sk-ant-api03-AbCdEf1234567890"];
/**
 * Older tests hold obviously fictional keys ("sk-proj-EXAMPLEKEY-...", "sk-test-FictionalLegacyKey..."). A match that sits in a tests/ file and
 * carries one of these words is accepted as a labelled fixture. A match without one fails, wherever it is. New tests build their key
 * fixtures from fragments instead. Limit: a real key that happens to contain one of these words inside a tests/ file would pass.
 */
const FICTION_WORD = /example|test|fiction|fake|dummy|placeholder|sample|savedkey|legacy/i;
const FIXTURE_DIRS = /^tests\//;
/** Source constants that are an alphabet, not a secret. */
const LONG_RUN_FILES = new Set(["src/lib/auth/TemporaryPassword.ts"]);
/** Files that are not text we can read, or that hold long encoded blobs by nature (lockfile integrity hashes, images, fonts). */
const SKIP_FILE = /(^|\/)package-lock\.json$|\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|eot|zip|gz|mp3|mp4|mov|wasm|xlsx?|docx?|pptx?)$/i;
/** Long-run matches that are not secrets: a path or an identifier in a known place. Keyed by "file: reason", kept small and reviewed. */
const LONG_RUN_OK = (file: string, run: string): boolean => HEX_ONLY.test(run) || /^[A-Z][a-z]+(?:[A-Z][a-z0-9]+){3,}$/.test(run) || /^[a-z]+(?:[A-Z][a-z0-9]+){3,}$/.test(run) || /^[A-Za-z]+$/.test(run) || file.endsWith(".svg");

function trackedFiles(): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    return null; // not a git checkout (a source archive): nothing to scan
  }
}

/** Every finding as "file:line: rule" with NO matched text, so a real hit never lands in a log. */
export function scan(files: { file: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { file, text } of files) {
    const lines = text.split("\n");
    lines.forEach((raw, i) => {
      let line = raw;
      for (const a of ALLOW) line = line.split(a).join("");
      const labelled = (m: RegExpMatchArray | null) => m !== null && FIXTURE_DIRS.test(file) && FICTION_WORD.test(m[0]);
      for (const p of PATTERNS) {
        const m = line.match(p.re);
        if (m && !labelled(m) && !(p.name === "database URL with a password" && /:(PASSWORD|password|YOUR_PASSWORD)@/.test(m[0]))) out.push(`${file}:${i + 1}: ${p.name}`);
      }
      if (!LONG_RUN_FILES.has(file)) for (const m of line.matchAll(LONG_RUN)) if (!LONG_RUN_OK(file, m[0]) && !labelled(m)) out.push(`${file}:${i + 1}: long unbroken run (${m[0].length} chars)`);
    });
  }
  return out;
}

describe("secret scan over tracked files (K15)", () => {
  const files = trackedFiles();

  it.skipIf(files === null)("finds no key-shaped string in any tracked text file", () => {
    const texts = (files ?? [])
      .filter((f) => !SKIP_FILE.test(f) && existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile() && statSync(path.join(root, f)).size < 2_000_000)
      .map((file) => ({ file, buf: readFileSync(path.join(root, file)) }))
      .filter((x) => !x.buf.subarray(0, 8000).includes(0))
      .map((x) => ({ file: x.file, text: x.buf.toString("utf8") }));
    expect(texts.length).toBeGreaterThan(100);
    expect(scan(texts)).toEqual([]);
  });

  describe("the scanner itself (fixtures are built from fragments at run time)", () => {
    const j = (...parts: string[]) => parts.join("");
    const hit = (text: string) => scan([{ file: "x.ts", text }]);

    it("catches the common shapes and names the rule, never the text", () => {
      const cases: [string, string][] = [
        [j("sk", "-proj-", "FICTION77ab12cd", "EFGH0123xy"), "sk-style key"],
        [j("gsk", "_", "FICTION77ab12cd", "EFGH0123xy"), "gsk_ key"],
        [j("xai", "-", "FICTION77ab12cd", "EFGH0123xy"), "xai- key"],
        [j("AI", "za", "FICTION77ab12cd", "-EFGH0123xy-FICTION77"), "Google API key"],
        [j("-----", "BEGIN RSA PRIVATE KEY", "-----"), "PEM private key header"],
        [j("Bear", "er ", "FICTION77ab12cd", "EFGH0123xy"), "bearer token"],
        [j("gh", "p_", "FICTION77ab12cd", "EFGH0123xyFICTION77"), "GitHub token"],
        [j("AK", "IA", "FICTION771234567"), "AWS access key id"],
        [j("xo", "xb-", "1234567890-FICTION77"), "Slack token"],
        [j("postgres", "://user:", "hunter22", "@db.internal:5432/app"), "database URL with a password"],
        ["Q7".repeat(20), "long unbroken run (40 chars)"],
      ];
      for (const [text, rule] of cases) {
        const found = hit(`const v = "${text}";`);
        expect(found, rule).toContain(`x.ts:1: ${rule}`);
        expect(found.join("")).not.toContain(text);
      }
    });

    it("accepts a labelled fixture only inside tests/, and refuses the same text elsewhere or without the label", () => {
      const labelled = j("sk", "-proj-", "EXAMPLEKEY-", "abcdefghijklmnop-WXYZ");
      expect(scan([{ file: "tests/a.test.ts", text: `const k = "${labelled}";` }])).toEqual([]);
      expect(scan([{ file: "src/lib/a.ts", text: `const k = "${labelled}";` }])).toEqual(["src/lib/a.ts:1: sk-style key"]);
      expect(scan([{ file: "tests/a.test.ts", text: `const k = "${j("sk", "-proj-", "Q7rT9xLm", "2VbN4cKd", "8HfJ")}";` }])).toEqual(["tests/a.test.ts:1: sk-style key"]);
    });

    it("lets through hashes, the migration's comment examples, local and example database URLs, and ordinary code", () => {
      expect(hit(`sha256 ${"a1b2c3d4".repeat(8)}`)).toEqual([]);
      expect(hit("e.g. sk-claims-v2, sk-summarizer2026 and sk-abcdefghij are custom names")).toEqual([]);
      expect(hit(j("postgres", "://postgres:postgres@127.0.0.1:5432/postgres"))).toEqual([]);
      expect(hit(j("postgres", "://user:pw1234@db.example.test/app"))).toEqual([]);
      expect(hit("export class AiModelRegistryServiceForTheOwnerOnly {}")).toEqual([]);
      expect(hit("gpt-6-luna gpt-realtime claude-3-5-haiku-20241022 xai-grok-4-fast")).toEqual([]);
    });
  });
});
