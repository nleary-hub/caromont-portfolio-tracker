import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, ".browser-fixture");
await mkdir(output, { recursive: true });
await build({ entryPoints: ["tests/browser/fixture.tsx"], outfile: path.join(output, "fixture.js"),
  bundle: true, platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{ name: "next-harness", setup(builder) {
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
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end(html); return; }
    const routes = { "/fixture.js": [path.join(output, "fixture.js"), "text/javascript"],
      "/fixture.css": [path.join(output, "fixture.css"), "text/css"],
      "/fonts/Inter-Variable.ttf": [path.join(root, "public/fonts/Inter-Variable.ttf"), "font/ttf"] };
    const route = routes[req.url];
    if (!route) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", route[1]); res.end(await readFile(route[0]));
  } catch { res.writeHead(500); res.end(); }
}).listen(4173, "127.0.0.1", () => console.log("Fictional dashboard fixture: http://127.0.0.1:4173"));
