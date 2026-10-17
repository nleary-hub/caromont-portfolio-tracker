import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = process.cwd();
// FIXTURE_PORT: a second harness (e.g. VERCEL_ENV=preview for the freeze guard spec) builds into its own folder.
const port = Number(process.env.FIXTURE_PORT || 4173);
const output = path.join(root, port === 4173 ? ".browser-fixture" : `.browser-fixture-${port}`);
await mkdir(output, { recursive: true });
await build({ entryPoints: ["tests/browser/fixture.tsx"], outfile: path.join(output, "fixture.js"),
  bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"', "process.env.VERCEL_ENV": JSON.stringify(process.env.VERCEL_ENV ?? "") },
  plugins: [{ name: "next-harness", setup(builder) {
    // "use server" action modules: Next turns these into network stubs in the browser, so the harness does the same
    // (async no-op exports) instead of bundling their server-only imports (database, auth, node:crypto).
    builder.onLoad({ filter: /src[\\/]app[\\/]actions[\\/][^\\/]+\.ts$/ }, async args => {
      const src = await readFile(args.path, "utf8");
      if (!/^\s*["']use server["']/.test(src)) return undefined;
      const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let)\s+(\w+)/gm)].map(m => m[1]);
      // A fixture may supply in-memory fakes on globalThis.__fixtureActions (fictional data only); otherwise null.
      return { contents: names.map(n => `export const ${n} = async (...a) => globalThis.__fixtureActions?.${n} ? globalThis.__fixtureActions.${n}(...a) : null;`).join("\n"), loader: "js" };
    });
    builder.onResolve({ filter: /^next\/(dynamic|link)$/ }, args => ({ path: args.path, namespace: "next-harness" }));
    builder.onLoad({ filter: /.*/, namespace: "next-harness" }, args => ({
      contents: `export { ${args.path.endsWith("dynamic") ? "dynamic" : "Link"} as default } from ${JSON.stringify(path.join(root, "tests/browser/next-shims.tsx"))}`,
      resolveDir: root,
    }));
  } }] });
const cssFile = path.join(root, "src/app/globals.css");
const css = await postcss([tailwind()]).process(await readFile(cssFile, "utf8"), { from: cssFile });
await writeFile(path.join(output, "fixture.css"), css.css);
const html = '<!doctype html><html class="dark"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
createServer(async (req, res) => {
  try {
    if (req.url === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (new URL(req.url, "http://127.0.0.1").pathname === "/") { res.setHeader("Content-Type", "text/html"); res.end(html); return; }
    const routes = { "/fixture.js": [path.join(output, "fixture.js"), "text/javascript"],
      "/fixture.css": [path.join(output, "fixture.css"), "text/css"],
      "/fonts/Inter-Variable.ttf": [path.join(root, "public/fonts/Inter-Variable.ttf"), "font/ttf"] };
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", route[1]); res.end(await readFile(route[0]));
  } catch { res.writeHead(500); res.end(); }
}).listen(port, "127.0.0.1", () => console.log(`Fictional dashboard fixture: http://127.0.0.1:${port}`));
